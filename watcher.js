const fs = require("fs");
const { chromium } = require("playwright");

const CGV_URL =
  "https://cgv.co.kr/cnm/movieBook/cinema?siteNm=%EC%9A%A9%EC%82%B0%EC%95%84%EC%9D%B4%ED%8C%8C%ED%81%AC%EB%AA%B0&siteNo=0013";

const MOVIE_KEYWORDS = ["오디세이", "ODYSSEY"];
const FORMAT_KEYWORD = "IMAX";
const MAX_START_MINUTES = 20 * 60; // 20:00 미만
const STATE_FILE = "notified.json";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RUN_MODE = process.env.RUN_MODE || "watch";

function requiredEnv() {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN Secret이 없습니다.");
  }
  if (!CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID Secret이 없습니다.");
  }
}

async function sendTelegram(text, url = CGV_URL) {
  const endpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          {
            text: "🎟 CGV 예매창 열기",
            url
          }
        ]]
      }
    })
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `텔레그램 전송 실패: ${result.description || response.status}`
    );
  }
}

function loadNotified() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveNotified(values) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(values.slice(-100), null, 2),
    "utf8"
  );
}

function absoluteUrl(value) {
  try {
    return new URL(value || CGV_URL, CGV_URL).toString();
  } catch {
    return CGV_URL;
  }
}

async function findSaturdayTabs(page) {
  const selector = "button, a, [role='button'], [role='tab'], li";
  const items = page.locator(selector);
  const count = Math.min(await items.count(), 800);

  const found = [];
  const seen = new Set();

  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);

    let text = "";
    try {
      text = (await item.innerText({ timeout: 500 })).replace(/\s+/g, " ").trim();
    } catch {
      continue;
    }

    if (!text || text.length > 30) continue;

    const hasSaturday =
      /(^|\s)토(\s|$)/.test(text) ||
      /^토\s*\d/.test(text) ||
      /\bSAT\b/i.test(text);

    const hasDateNumber = /\d{1,2}([./-]\d{1,2})?/.test(text);

    if (!hasSaturday || !hasDateNumber || seen.has(text)) continue;

    seen.add(text);
    found.push({ index, text });
  }

  return { selector, tabs: found };
}

async function scanCurrentPage(page, dateLabel) {
  return await page.evaluate(
    ({ movieKeywords, formatKeyword, maxMinutes, dateLabel }) => {
      const normalize = (value) =>
        (value || "").replace(/\s+/g, " ").trim();

      const parseTime = (text) => {
        const match = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
        if (!match) return null;

        const hour = Number(match[1]);
        const minute = Number(match[2]);

        return {
          label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
          total: hour * 60 + minute
        };
      };

      const elements = [
        ...document.querySelectorAll(
          "a, button, [role='button'], [class*='time'], [class*='screen'], li"
        )
      ];

      const results = [];
      const seen = new Set();

      for (const element of elements) {
        const ownText = normalize(element.innerText || element.textContent);
        const time = parseTime(ownText);

        if (!time || time.total >= maxMinutes) continue;

        let contextNode = element;
        let contextText = "";

        for (let depth = 0; contextNode && depth < 10; depth += 1) {
          const text = normalize(
            contextNode.innerText || contextNode.textContent
          );

          const hasMovie = movieKeywords.some((keyword) =>
            text.toUpperCase().includes(keyword.toUpperCase())
          );
          const hasFormat = text
            .toUpperCase()
            .includes(formatKeyword.toUpperCase());

          if (hasMovie && hasFormat && text.length < 5000) {
            contextText = text;
            break;
          }

          contextNode = contextNode.parentElement;
        }

        if (!contextText) continue;
        if (/매진|예매종료|판매종료|상영종료/.test(contextText)) continue;
        if (
          element.matches("[disabled], [aria-disabled='true']")
        ) {
          continue;
        }

        const anchor =
          element.matches("a[href]")
            ? element
            : element.querySelector("a[href]") ||
              element.closest("a[href]");

        const href = anchor?.href || location.href;
        const key = `${dateLabel}|${time.label}|${href}`;

        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          dateLabel,
          time: time.label,
          href,
          context: contextText.slice(0, 500)
        });
      }

      return results.sort((a, b) => a.time.localeCompare(b.time));
    },
    {
      movieKeywords: MOVIE_KEYWORDS,
      formatKeyword: FORMAT_KEYWORD,
      maxMinutes: MAX_START_MINUTES,
      dateLabel
    }
  );
}

async function collectMatches(page) {
  await page.goto(CGV_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(7000);

  const { selector, tabs } = await findSaturdayTabs(page);
  console.log(`토요일 탭 후보: ${tabs.length}개`);

  const allMatches = [];
  const seen = new Set();

  for (const tab of tabs) {
    const item = page.locator(selector).nth(tab.index);

    try {
      console.log(`검사 중: ${tab.text}`);
      await item.scrollIntoViewIfNeeded();
      await item.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(2500);
    } catch (error) {
      console.log(`날짜 선택 실패: ${tab.text} / ${error.message}`);
      continue;
    }

    const matches = await scanCurrentPage(page, tab.text);

    for (const match of matches) {
      const key = `${match.dateLabel}|${match.time}|${match.href}`;
      if (seen.has(key)) continue;

      seen.add(key);
      allMatches.push(match);
    }
  }

  return allMatches;
}

async function main() {
  requiredEnv();

  if (RUN_MODE === "test") {
    await sendTelegram(
      [
        "✅ CGV 알림봇 연결 테스트 성공",
        "",
        "감시 조건",
        "• CGV 용산아이파크몰",
        "• 오디세이 IMAX",
        "• 토요일",
        "• 20:00 이전",
        "• 좌석은 I열 이후 직접 선택"
      ].join("\n")
    );

    console.log("텔레그램 테스트 메시지를 전송했습니다.");
    return;
  }

  const browser = await chromium.launch({
    headless: true
  });

  try {
    const context = await browser.newContext({
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/126.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();
    const matches = await collectMatches(page);

    console.log(`조건에 맞는 회차: ${matches.length}개`);

    if (!matches.length) {
      console.log("조건에 맞는 회차가 아직 없습니다.");
      return;
    }

    const notified = loadNotified();
    const notifiedSet = new Set(notified);
    const newKeys = [];

    for (const match of matches) {
      const bookingUrl = absoluteUrl(match.href);
      const key = `${match.dateLabel}|${match.time}|${bookingUrl}`;

      if (notifiedSet.has(key)) continue;

      const message = [
        "🎬 오디세이 용산 IMAX 예매 오픈",
        "",
        `📅 ${match.dateLabel}`,
        `🕒 ${match.time} 시작`,
        "📍 CGV 용산아이파크몰 IMAX",
        "💺 I열 이후 좌석을 직접 선택하세요."
      ].join("\n");

      await sendTelegram(message, bookingUrl);
      console.log(`알림 전송 완료: ${key}`);

      notifiedSet.add(key);
      newKeys.push(key);
    }

    if (newKeys.length) {
      saveNotified([...notifiedSet]);
    } else {
      console.log("이미 알림을 보낸 회차뿐입니다.");
    }
  } finally {
    await browser.close();
  }
}

main().catch(async (error) => {
  console.error(error);

  try {
    if (BOT_TOKEN && CHAT_ID) {
      await sendTelegram(
        [
          "⚠️ CGV 감시기 실행 오류",
          "",
          error.message,
          "",
          "GitHub Actions 실행 기록을 확인하세요."
        ].join("\n")
      );
    }
  } catch {
    // 오류 알림 전송까지 실패한 경우에는 콘솔 기록만 남깁니다.
  }

  process.exit(1);
});
