function escapeHtml(value: unknown): string {
  const normalized = String(value ?? "");
  return normalized
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function withParams(origin: string, params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return `${origin}/?${search.toString()}`;
}

export function buildOwnerClaimEmail(input: {
  origin: string;
  ownerEmail: string;
  agentName: string;
  flowKind: "new_registration" | "existing_email_resolution";
  claimToken: string;
  expiresAt: string;
}) {
  const claimUrl = withParams(input.origin, {
    claim_token: input.claimToken,
    email: input.ownerEmail
  });

  const introText =
    input.flowKind === "new_registration"
      ? "你的 AI Agent 正在请求绑定这个邮箱。请打开页面确认是否同意绑定并激活。"
      : "这个邮箱已经绑定过 OpenSlaw。请打开页面选择：迁移换绑到当前 AI Agent、清空历史后重新开始，或改用其他邮箱。";
  const introHtml =
    input.flowKind === "new_registration"
      ? "你的 AI Agent 正在请求绑定这个邮箱。请打开页面确认是否同意绑定并激活。"
      : "这个邮箱已经绑定过 OpenSlaw。请打开页面选择：迁移换绑到当前 AI Agent、清空历史后重新开始，或改用其他邮箱。";

  return {
    claim_url: claimUrl,
    subject: `确认你的 OpenSlaw 绑定请求：${input.agentName}`,
    text:
      `${introText}\n\n` +
      `请点击下面的链接进入确认页面：\n${claimUrl}\n\n` +
      `当前 AI Agent：${input.agentName}\n` +
      `有效期至：${input.expiresAt}\n\n` +
      `你只需要在网页完成确认，不需要把链接或 token 再转发给 AI Agent。\n\n` +
      `确认后，你就可以进入 OpenSlaw 网页查看余额、订单和交易状态。\n`,
    html:
      `<p>${escapeHtml(introHtml)}</p>` +
      `<p><a href="${escapeHtml(claimUrl)}">点击这里进入确认页面</a></p>` +
      `<p>当前 AI Agent：<strong>${escapeHtml(input.agentName)}</strong></p>` +
      `<p>有效期至：<code>${escapeHtml(input.expiresAt)}</code></p>` +
      `<p>你只需要在网页完成确认，不需要把链接或 token 再转发给 AI Agent。</p>` +
      `<p>确认后，你就可以进入 OpenSlaw 网页查看该 Agent 的余额、订单和交易状态。</p>`
  };
}

export function buildOwnerLoginEmail(input: {
  origin: string;
  ownerEmail: string;
  displayName: string;
  loginToken: string;
  expiresAt: string;
}) {
  const loginUrl = withParams(input.origin, {
    owner_email: input.ownerEmail,
    owner_login_token: input.loginToken,
    owner_auto_login: "1"
  });

  return {
    login_url: loginUrl,
    subject: "登录 OpenSlaw Owner Console",
    text:
      `你好，${input.displayName}。\n\n` +
      `请点击下面的链接登录 OpenSlaw Owner Console：\n${loginUrl}\n\n` +
      `有效期至：${input.expiresAt}\n`,
    html:
      `<p>你好，${escapeHtml(input.displayName)}。</p>` +
      `<p><a href="${escapeHtml(loginUrl)}">点击这里登录 OpenSlaw Owner Console</a></p>` +
      `<p>有效期至：<code>${escapeHtml(input.expiresAt)}</code></p>`
  };
}
