function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

function getText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readPayload(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return await request.json();
  }

  const formData = await request.formData();
  const data = {};

  for (const [key, value] of formData.entries()) {
    data[key] = typeof value === "string" ? value : "";
  }

  return data;
}

async function sendWithResend(env, emailData) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(emailData),
  });

  const resultText = await response.text();

  if (!response.ok) {
    console.error("Resend API error:", response.status, resultText);
  }

  return {
    ok: response.ok,
    status: response.status,
    body: resultText,
  };
}

/**
 * ブラウザで /api/contact を直接開いたときの確認用
 */
export function onRequestGet() {
  return jsonResponse({
    success: true,
    message: "Contact API is running.",
  });
}

/**
 * お問い合わせフォーム送信用
 */
export async function onRequestPost({ request, env }) {
  try {
    const requiredVariables = [
      "RESEND_API_KEY",
      "TURNSTILE_SECRET_KEY",
      "MAIL_TO",
      "MAIL_FROM",
    ];

    const missingVariables = requiredVariables.filter(
      (name) => !getText(env[name])
    );

    if (missingVariables.length > 0) {
      console.error(
        "Missing environment variables:",
        missingVariables.join(", ")
      );

      return jsonResponse(
        {
          success: false,
          message: "サーバー設定が完了していません。",
        },
        500
      );
    }

    const data = await readPayload(request);

    // contact.html側の表記揺れにも対応
    const name = getText(data.name || data.fullName);
    const email = getText(data.email);

    const category = getText(
      data.category ||
        data.inquiryType ||
        data.inquiry_type ||
        data.type ||
        "その他"
    );

    const message = getText(
      data.message ||
        data.content ||
        data.inquiry ||
        data.inquiryContent ||
        data.inquiry_content
    );

    const turnstileToken = getText(
      data["cf-turnstile-response"] ||
        data.turnstileToken ||
        data.turnstile_token ||
        data.token
    );

    if (!name || !email || !message) {
      return jsonResponse(
        {
          success: false,
          message: "必須項目を入力してください。",
        },
        400
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse(
        {
          success: false,
          message: "メールアドレスの形式を確認してください。",
        },
        400
      );
    }

    if (!turnstileToken) {
      return jsonResponse(
        {
          success: false,
          message: "スパム対策の確認が完了していません。",
        },
        400
      );
    }

    // Turnstileのサーバー側検証
    const turnstileResponse = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: turnstileToken,
          remoteip: request.headers.get("CF-Connecting-IP"),
        }),
      }
    );

    const turnstileResult = await turnstileResponse.json();

    if (!turnstileResult.success) {
      console.error(
        "Turnstile verification failed:",
        turnstileResult["error-codes"]
      );

      return jsonResponse(
        {
          success: false,
          message:
            "スパム対策の確認に失敗しました。チェックをやり直してください。",
        },
        400
      );
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeCategory = escapeHtml(category);
    const safeMessage = escapeHtml(message).replaceAll("\n", "<br>");

    const adminEmail = {
      from: env.MAIL_FROM,
      to: [env.MAIL_TO],
      reply_to: email,
      subject: `[Liquid お問い合わせ] ${category
        .replaceAll("\r", " ")
        .replaceAll("\n", " ")
        .slice(0, 100)}`,
      text: [
        "Liquid Webサイトからお問い合わせがありました。",
        "",
        `お名前：${name}`,
        `メールアドレス：${email}`,
        `お問い合わせ種別：${category}`,
        "",
        "お問い合わせ内容：",
        message,
        "",
        `受付日時：${new Date().toISOString()}`,
      ].join("\n"),
      html: `
        <h2>Liquid Webサイトからお問い合わせがありました</h2>
        <p><strong>お名前：</strong>${safeName}</p>
        <p><strong>メールアドレス：</strong>${safeEmail}</p>
        <p><strong>お問い合わせ種別：</strong>${safeCategory}</p>
        <p><strong>お問い合わせ内容：</strong></p>
        <p>${safeMessage}</p>
        <hr>
        <p>受付日時：${escapeHtml(new Date().toISOString())}</p>
      `,
    };

    if (getText(env.MAIL_BCC)) {
      adminEmail.bcc = env.MAIL_BCC
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
    }

    const adminResult = await sendWithResend(env, adminEmail);

    if (!adminResult.ok) {
      return jsonResponse(
        {
          success: false,
          message:
            "メール送信処理に失敗しました。時間を置いて再度お試しください。",
        },
        502
      );
    }

    // 任意：お問い合わせをした本人へ自動返信
    if (String(env.SEND_AUTO_REPLY).toLowerCase() === "true") {
      const autoReplyResult = await sendWithResend(env, {
        from: env.MAIL_FROM,
        to: [email],
        reply_to: env.MAIL_TO,
        subject: "【Liquid】お問い合わせを受け付けました",
        text: [
          `${name} 様`,
          "",
          "お問い合わせいただき、ありがとうございます。",
          "以下の内容で受け付けました。",
          "",
          `お問い合わせ種別：${category}`,
          "",
          "お問い合わせ内容：",
          message,
          "",
          "内容を確認のうえ、通常2〜3営業日以内にご返信いたします。",
        ].join("\n"),
      });

      // 自動返信だけ失敗しても、管理者宛てメールが送信済みなら受付成功とする
      if (!autoReplyResult.ok) {
        console.error("Auto reply failed.");
      }
    }

    return jsonResponse({
      success: true,
      message: "お問い合わせを送信しました。",
    });
  } catch (error) {
    console.error("Contact function error:", error);

    return jsonResponse(
      {
        success: false,
        message:
          "送信処理中にエラーが発生しました。時間を置いて再度お試しください。",
      },
      500
    );
  }
}

