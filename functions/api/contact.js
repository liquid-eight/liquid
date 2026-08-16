/**
 * Cloudflare Pages Functions - お問い合わせフォーム受信エンドポイント
 * ルート: POST https://liquid.crypto-eight.com/api/contact
 *
 * このファイルは「リポジトリ直下の functions/api/contact.js」に置く必要があります。
 * （Cloudflare Pages のビルド出力ディレクトリ直下の functions/ が自動でAPIになります）
 *
 * ===== 必要な環境変数（Cloudflare Pages > 設定 > 環境変数）=====
 *  RESEND_API_KEY        [必須・シークレット] Resend の API キー（re_ で始まる文字列）
 *  TURNSTILE_SECRET_KEY  [必須・シークレット] Turnstile のシークレットキー
 *  MAIL_TO               [必須] 受信先。例: liquid-info@crypto-eight.com
 *  MAIL_FROM             [必須] 差出人。例: Liquid <noreply@send.crypto-eight.com>
 *                              ※Resendでドメイン認証済みのアドレスのみ使用可
 *  SEND_AUTO_REPLY       [任意] "true" で送信者本人への自動返信も行う（要ドメイン認証）
 *  MAIL_BCC              [任意] 控え用のBCCアドレス
 *
 * ===== 設定の確認方法 =====
 *  ブラウザで https://liquid.crypto-eight.com/api/contact?diag=1 を開くと、
 *  環境変数の設定状況を確認できます（値そのものは表示されません）。
 *
 * ===== 設計方針 =====
 *  1. 応答は必ず JSON。想定外の例外もCloudflareのHTMLエラー画面にせず JSON で返す。
 *  2. 失敗時は code を返す。UIのメッセージから原因箇所を特定できるようにするため。
 *  3. 通知メールの送信が成功したら、その後に何が起きても「成功」として返す。
 *     （メールは届いているのに画面はエラー、という食い違いを構造的に防ぐ）
 */

/** 種別のホワイトリスト（contact.html の <select> と一致させること） */
const CATEGORIES = [
  "サービス内容について",
  "料金・お支払いについて",
  "技術的なご質問",
  "提携・取材のご相談",
  "その他",
];

const LIMITS = { name: 100, email: 254, message: 5000 };

/** 同一IPからの連投抑止（isolate単位のベストエフォート。主防御はTurnstile） */
const RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };
const recentPosts = new Map();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// =====================================================================
// エントリポイント
// =====================================================================
export async function onRequest(context) {
  // 通知メールを送り終えたかどうか。送信後の例外を「成功」に倒すために使う
  const state = { mailSent: false };

  try {
    return await handleRequest(context, state);
  } catch (err) {
    console.error("[contact] 予期しないエラー:", err && err.stack ? err.stack : String(err));

    // メールは既に送信済み → 利用者にとっては成功。エラー画面にしない
    if (state.mailSent) {
      return json({ ok: true, warning: "post_send_error" });
    }
    return json(
      {
        ok: false,
        code: "unexpected_error",
        error: "サーバー側で予期しないエラーが発生しました。お手数ですがメールにて直接ご連絡ください。",
      },
      500,
    );
  }
}

async function handleRequest(context, state) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "POST" } });
  }

  // --- 設定確認用エンドポイント（値は返さず、設定済みかどうかだけ） ---
  if (request.method === "GET") {
    const url = new URL(request.url);
    if (url.searchParams.get("diag") === "1") {
      return json(diagnostics(env));
    }
    return json(
      { ok: false, code: "method_not_allowed", error: "このURLはフォーム送信専用です。" },
      405,
      { Allow: "POST" },
    );
  }

  if (request.method !== "POST") {
    return json(
      { ok: false, code: "method_not_allowed", error: "許可されていないメソッドです。" },
      405,
      { Allow: "POST" },
    );
  }

  // --- 他サイトからの投稿を拒否（同一オリジンのみ許可） ---
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin && origin !== expected) {
    console.warn(`[contact] Origin不一致: ${origin} (期待値: ${expected})`);
    return json(
      { ok: false, code: "bad_origin", error: "不正なリクエストです。" },
      403,
    );
  }

  // --- サーバー設定チェック（未設定のまま静かに動くのを防ぐ） ---
  const missing = ["RESEND_API_KEY", "TURNSTILE_SECRET_KEY", "MAIL_TO", "MAIL_FROM"].filter(
    (key) => !str(env[key]),
  );
  if (missing.length) {
    console.error("[contact] 環境変数が未設定です: " + missing.join(", "));
    return json(
      {
        ok: false,
        code: "server_misconfigured",
        missing: missing,
        error: "サーバー設定が未完了のため送信できません。お手数ですがメールにてご連絡ください。",
      },
      500,
    );
  }

  const fromError = validateFrom(env.MAIL_FROM);
  if (fromError) {
    console.error("[contact] MAIL_FROM の形式が不正です: " + fromError);
    return json(
      {
        ok: false,
        code: "invalid_mail_from",
        error: "サーバー設定（差出人アドレス）に誤りがあります。お手数ですがメールにてご連絡ください。",
      },
      500,
    );
  }

  // --- 本文の取得 ---
  if (Number(request.headers.get("Content-Length") || 0) > 100 * 1024) {
    return json(
      { ok: false, code: "payload_too_large", error: "内容が大きすぎます。" },
      413,
    );
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return json(
      { ok: false, code: "invalid_json", error: "リクエストの形式が正しくありません。" },
      400,
    );
  }

  const name = str(data.name);
  const email = str(data.email);
  const message = str(data.message);
  const category = CATEGORIES.includes(str(data.category)) ? str(data.category) : "その他";
  const agree = data.agree === true;
  const honeypot = str(data.company);
  const token = str(data.token);

  // --- ハニーポット：botだけが埋める隠しフィールド。成功を装って破棄する ---
  if (honeypot) {
    console.warn("[contact] ハニーポットに入力あり。破棄しました。");
    return json({ ok: true });
  }

  // --- 入力検証 ---
  const invalid = validateInput({ name, email, message, agree });
  if (invalid) {
    return json({ ok: false, code: "validation_error", error: invalid }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // --- Turnstile 検証 ---
  if (!token) {
    return json(
      {
        ok: false,
        code: "turnstile_missing",
        error: "認証が完了していません。「ロボットではありません」の確認を行ってください。",
      },
      400,
    );
  }
  const turnstile = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, ip);
  if (!turnstile.success) {
    return json(
      {
        ok: false,
        code: "turnstile_failed",
        detail: turnstile.errors,
        error: "認証に失敗しました。ページを再読み込みのうえ、もう一度お試しください。",
      },
      403,
    );
  }

  // --- 連投抑止 ---
  if (isRateLimited(ip)) {
    return json(
      {
        ok: false,
        code: "rate_limited",
        error: "送信回数の上限に達しました。しばらく時間をおいてお試しください。",
      },
      429,
    );
  }

  // --- 管理者への通知メール ---
  const cf = request.cf || {};
  const meta = [
    `送信元IP: ${ip}`,
    `国: ${cf.country || "-"}`,
    `User-Agent: ${str(request.headers.get("User-Agent")).slice(0, 200)}`,
  ].join("\n");

  const sent = await sendMail(env.RESEND_API_KEY, {
    from: env.MAIL_FROM,
    to: [env.MAIL_TO],
    bcc: str(env.MAIL_BCC) ? [str(env.MAIL_BCC)] : undefined,
    reply_to: email, // 受信箱でそのまま「返信」すれば送信者に届く
    subject: `[お問い合わせ] ${category} / ${name}`,
    text: buildNotificationText({ name, email, category, message, meta }),
    html: buildNotificationHtml({ name, email, category, message, meta }),
  });

  if (!sent.ok) {
    console.error(`[contact] 通知メールの送信に失敗: status=${sent.status} body=${sent.detail}`);
    return json(
      {
        ok: false,
        code: "mail_failed",
        status: sent.status,
        error: "送信処理に失敗しました。お手数ですがメールにて直接ご連絡ください。",
      },
      502,
    );
  }

  // ここから先で何が起きても、利用者から見た送信は成功している
  state.mailSent = true;
  console.log(`[contact] 送信成功 id=${sent.id || "-"} category=${category}`);

  // --- 送信者への自動返信 ---
  // 応答をブロックしないよう waitUntil でバックグラウンド実行する。
  // Resend は 2リクエスト/秒 の制限があるため、少し待ってから送る。
  if (str(env.SEND_AUTO_REPLY).toLowerCase() === "true") {
    const task = (async () => {
      await sleep(700);
      const auto = await sendMail(env.RESEND_API_KEY, {
        from: env.MAIL_FROM,
        to: [email],
        reply_to: env.MAIL_TO,
        subject: "【Liquid】お問い合わせを受け付けました",
        text: buildAutoReplyText({ name, category, message, mailTo: env.MAIL_TO }),
      });
      if (!auto.ok) {
        console.error(`[contact] 自動返信の送信に失敗: status=${auto.status} body=${auto.detail}`);
      }
    })();

    if (context.waitUntil) {
      context.waitUntil(task);
    } else {
      task.catch((err) => console.error("[contact] 自動返信でエラー:", err));
    }
  }

  return json({ ok: true, id: sent.id || null });
}

// =====================================================================
// 外部サービス
// =====================================================================

/** Turnstile のトークンを Cloudflare 側で検証する */
async function verifyTurnstile(token, secret, ip) {
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: secret, response: token, remoteip: ip }),
    });
    const result = await res.json();
    if (!result.success) {
      console.warn("[contact] Turnstile検証NG:", JSON.stringify(result["error-codes"] || []));
    }
    return { success: result.success === true, errors: result["error-codes"] || [] };
  } catch (err) {
    console.error("[contact] Turnstile検証でエラー:", err);
    return { success: false, errors: ["verify-request-failed"] };
  }
}

/**
 * Resend API 経由でメールを送信する。
 * 429（レート制限）と 5xx は1度だけ再試行する。いずれも「送信されていない」
 * ことが確定している応答なので、再試行で重複メールにはならない。
 */
async function sendMail(apiKey, payload) {
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(800);

    let res;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: body,
      });
    } catch (err) {
      // ネットワーク到達失敗。応答が返っていないので再試行の余地がある
      if (attempt === 0) continue;
      return { ok: false, status: 0, detail: String(err) };
    }

    const raw = await res.text();

    if (res.ok) {
      let id = null;
      try {
        id = JSON.parse(raw).id || null;
      } catch {
        /* 応答がJSONでなくても送信自体は成功しているので無視する */
      }
      return { ok: true, status: res.status, id: id };
    }

    const retriable = res.status === 429 || res.status >= 500;
    if (retriable && attempt === 0) continue;

    return { ok: false, status: res.status, detail: raw.slice(0, 500) };
  }

  return { ok: false, status: 0, detail: "unreachable" };
}

// =====================================================================
// メール本文
// =====================================================================

function buildNotificationText({ name, email, category, message, meta }) {
  return (
    `Webサイトのお問い合わせフォームから新しい問い合わせが届きました。\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `お名前: ${name}\n` +
    `メールアドレス: ${email}\n` +
    `お問い合わせ種別: ${category}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${message}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n${meta}\n`
  );
}

function buildNotificationHtml({ name, email, category, message, meta }) {
  return (
    `<div style="font-family:sans-serif;line-height:1.7;color:#23191f">` +
    `<p>Webサイトのお問い合わせフォームから新しい問い合わせが届きました。</p>` +
    `<table style="border-collapse:collapse;margin:16px 0">` +
    row("お名前", esc(name)) +
    row("メールアドレス", `<a href="mailto:${esc(email)}">${esc(email)}</a>`) +
    row("お問い合わせ種別", esc(category)) +
    `</table>` +
    `<div style="white-space:pre-wrap;background:#fff7f9;border-left:3px solid #920883;padding:12px 16px">${esc(message)}</div>` +
    `<p style="color:#86717e;font-size:12px;white-space:pre-wrap;margin-top:20px">${esc(meta)}</p>` +
    `</div>`
  );
}

function buildAutoReplyText({ name, category, message, mailTo }) {
  return (
    `${name} 様\n\n` +
    `お問い合わせいただきありがとうございます。以下の内容で受け付けいたしました。\n` +
    `内容を確認のうえ、通常2〜3営業日以内にご返信いたします。\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `お問い合わせ種別: ${category}\n\n` +
    `${message}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `※本メールは自動送信です。ご返信いただいても対応いたしかねます。\n\n` +
    `Liquid\n${mailTo}\n`
  );
}

// =====================================================================
// 検証・ユーティリティ
// =====================================================================

/** 入力エラーがあればメッセージを、問題なければ null を返す */
function validateInput({ name, email, message, agree }) {
  if (!name || !email || !message) return "必須項目（*）をすべてご入力ください。";
  if (name.length > LIMITS.name || email.length > LIMITS.email) return "入力が長すぎます。";
  if (message.length > LIMITS.message)
    return `お問い合わせ内容は${LIMITS.message}文字以内でご入力ください。`;
  if (!EMAIL_RE.test(email)) return "メールアドレスの形式をご確認ください。";
  if (!agree) return "プライバシーポリシーへの同意にチェックを入れてください。";
  return null;
}

/** MAIL_FROM は "a@b.com" または "表示名 <a@b.com>" のどちらかであること */
function validateFrom(value) {
  const raw = str(value);
  const match = raw.match(/^(.*)<([^<>]+)>$/);
  const address = match ? match[2].trim() : raw;
  if (!EMAIL_RE.test(address)) return `メールアドレスとして解釈できません: ${raw}`;
  return null;
}

function isRateLimited(ip) {
  const now = Date.now();
  const history = (recentPosts.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (history.length >= RATE_LIMIT.max) {
    recentPosts.set(ip, history);
    return true;
  }
  history.push(now);
  recentPosts.set(ip, history);
  if (recentPosts.size > 1000) recentPosts.clear(); // メモリ肥大の保険
  return false;
}

/** 設定状況の確認用。値そのものは返さず、設定の有無と伏せ字だけを返す */
function diagnostics(env) {
  return {
    ok: true,
    service: "contact-form",
    env: {
      RESEND_API_KEY: str(env.RESEND_API_KEY) ? "設定済み" : "未設定",
      TURNSTILE_SECRET_KEY: str(env.TURNSTILE_SECRET_KEY) ? "設定済み" : "未設定",
      MAIL_TO: str(env.MAIL_TO) ? "設定済み" : "未設定",
      MAIL_FROM: str(env.MAIL_FROM) ? "設定済み" : "未設定",
      SEND_AUTO_REPLY: str(env.SEND_AUTO_REPLY) || "(未設定)",
      MAIL_BCC: str(env.MAIL_BCC) ? "設定済み" : "(未設定)",
    },
    mailTo: mask(env.MAIL_TO),
    mailFrom: mask(env.MAIL_FROM),
    mailFromError: str(env.MAIL_FROM) ? validateFrom(env.MAIL_FROM) : "未設定",
  };
}

/** アドレスの表示用マスク。ドメインだけ見せて、ローカル部は伏せる */
function mask(value) {
  const raw = str(value);
  if (!raw) return null;
  const match = raw.match(/^(.*)<([^<>]+)>$/);
  const address = match ? match[2].trim() : raw;
  const at = address.indexOf("@");
  if (at < 1) return "(形式不正)";
  return address[0] + "***" + address.slice(at);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function row(label, valueHtml) {
  return (
    `<tr><th style="text-align:left;padding:4px 16px 4px 0;color:#53424d;white-space:nowrap">${esc(label)}</th>` +
    `<td style="padding:4px 0">${valueHtml}</td></tr>`
  );
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
