import { applyLocaleToDocument, resolveLocaleRuntime } from "./locale.js";

function normalizePathBase(value) {
  if (!value || value === "/") {
    return "";
  }

  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function resolveRuntimeAppBase() {
  const explicitBase = import.meta.env.VITE_APP_BASE;
  if (explicitBase) {
    return normalizePathBase(explicitBase);
  }

  const trimmedPath = window.location.pathname.replace(/\/+$/, "");
  if (!trimmedPath) {
    return "";
  }

  const segments = trimmedPath.split("/").filter(Boolean);
  if (!segments.length) {
    return "";
  }

  const lastSegment = segments[segments.length - 1];
  const effectiveSegments = lastSegment.includes(".") ? segments.slice(0, -1) : segments;
  return effectiveSegments.length ? `/${effectiveSegments.join("/")}` : "";
}

const appBase = resolveRuntimeAppBase();
const apiBase = import.meta.env.VITE_API_BASE ?? `${appBase || ""}/api/v1`;
const appHomePath = appBase ? `${appBase}/` : "/";
const storageKey = "openslaw-demo-state";
const query = new URLSearchParams(window.location.search);
const devMode = query.get("dev") === "1";
const locale = resolveLocaleRuntime({
  query,
  env: import.meta.env,
  location: window.location
});

const state = {
  showcase: null,
  provider: null,
  buyer: null,
  claim: null,
  claimPreview: null,
  claimRequest: null,
  ownerAuth: null,
  ownerDashboard: null,
  listing: null,
  demand: null,
  demandSearch: null,
  demandDetail: null,
  proposal: null,
  proposalList: null,
  search: null,
  detail: null,
  quote: null,
  order: null,
  inspection: null
};

function el(id) {
  return document.getElementById(id);
}

function has(id) {
  return Boolean(el(id));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    Object.assign(state, saved);
  } catch {
    // ignore broken local state
  }
}

function persistState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function setPre(id, value) {
  if (!has(id)) {
    return;
  }

  el(id).textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function setHtml(id, value) {
  if (!has(id)) {
    return;
  }

  el(id).innerHTML = value;
}

function toggle(id, show) {
  if (!has(id)) {
    return;
  }

  el(id).classList.toggle("hidden", !show);
}

function showBanner(message, kind = "ok") {
  if (!has("page-banner")) {
    return;
  }

  const banner = el("page-banner");
  banner.textContent = message;
  banner.className = `page-banner ${kind}`;
}

function clearBanner() {
  if (!has("page-banner")) {
    return;
  }

  const banner = el("page-banner");
  banner.textContent = "";
  banner.className = "page-banner hidden";
}

function focusOwnerShell() {
  if (!has("owner-shell")) {
    return;
  }

  el("owner-shell").scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function logStep(label, payload) {
  if (!has("event-log")) {
    return;
  }

  const current = el("event-log").textContent || "";
  const next =
    `${new Date().toISOString()}  ${label}\n` +
    `${typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}\n\n`;
  el("event-log").textContent = `${next}${current}`.trim();
}

function formatCoins(value) {
  return `${Number(value ?? 0)} ${locale.message("coinsSuffix")}`;
}

function formatMinutes(value) {
  const minutes = Number(value ?? 0);
  if (!minutes) {
    return locale.message("notProvided");
  }
  if (minutes < 60) {
    return locale.message("minutesShort", { value: minutes });
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? locale.message("hoursWithMinutes", { hours, minutes: rest })
    : locale.message("hoursShort", { value: hours });
}

function formatSeconds(value) {
  const seconds = Number(value ?? 0);
  if (!seconds) {
    return locale.message("noRecord");
  }
  if (seconds < 60) {
    return locale.message("secondsShort", { value: seconds });
  }
  if (seconds < 3600) {
    return locale.message("minutesLong", { value: Math.round(seconds / 60) });
  }
  return locale.message("hoursShort", { value: Math.round(seconds / 3600) });
}

function formatDate(value) {
  if (!value) {
    return locale.message("unknown");
  }

  return new Intl.DateTimeFormat(locale.dateLocale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatAcceptMode(value) {
  return locale.lookup(
    "acceptModes",
    value,
    value === "auto_accept"
      ? locale.lookup("acceptModes", "auto_accept", value)
      : locale.lookup("acceptModes", "manual_review", value)
  );
}

function formatRuntimeKind(value) {
  return locale.lookup(
    "runtimeKinds",
    value,
    value === "openclaw"
      ? locale.lookup("runtimeKinds", "openclaw", value)
      : locale.lookup("runtimeKinds", "generic", value)
  );
}

function formatAutomationMode(value) {
  return locale.lookup(
    "automationModes",
    value,
    value === "openclaw_auto"
      ? locale.lookup("automationModes", "openclaw_auto", value)
      : locale.lookup("automationModes", "manual", value)
  );
}

function formatRuntimeHealth(value) {
  return locale.lookup("runtimeHealth", value, value);
}

function formatRuntimeSource(value) {
  return locale.lookup("runtimeSources", value, value);
}

function formatRuntimeEventType(value) {
  return locale.lookup("runtimeEvents", value, value ?? locale.message("noRecord"));
}

function formatNotificationTarget(target) {
  if (!target || typeof target !== "object") {
    return locale.message("notConfigured");
  }

  const channel = target.channel_kind ? String(target.channel_kind) : locale.message("unknownChannel");
  const label = target.label ? String(target.label) : "";
  const value = target.target ? String(target.target) : "";
  return [channel, label || value].filter(Boolean).join(" / ");
}

function formatRelayStatus(value) {
  return locale.lookup("relayStatus", value, locale.message("notConfigured"));
}

function formatNextExpectedActor(value) {
  return locale.lookup("nextExpectedActors", value, locale.message("undefinedLabel"));
}

function formatNextExpectedAction(value) {
  return locale.lookup("nextExpectedActions", value, locale.message("undefinedLabel"));
}

function joinBlockers(blockers, fallback) {
  return Array.isArray(blockers) && blockers.length ? blockers.join(" / ") : fallback;
}

function summarizeOrderStatus(status, escrowStatus, order = null) {
  if (status === "delivered" && escrowStatus === "held") {
    if (order?.had_revision_cycle) {
      return locale.message("orderSummaryDeliveredRevision", {
        extra: order?.review_deadline_at ? locale.message("orderSummaryDeliveredRevisionExtra") : ""
      });
    }

    return locale.message("orderSummaryDeliveredHeld");
  }
  if (status === "revision_requested") {
    return order?.latest_revision_commentary
      ? locale.message("orderSummaryRevisionRequestedWithComment", {
          comment: String(order.latest_revision_commentary)
        })
      : locale.message("orderSummaryRevisionRequested");
  }
  if (status === "completed" && escrowStatus === "released") {
    return locale.message("orderSummaryCompleted");
  }
  if (status === "accepted" || status === "in_progress") {
    return locale.message("orderSummaryInProgress");
  }
  if (status === "queued_for_provider") {
    return locale.message("orderSummaryQueued");
  }
  if (status === "disputed") {
    return locale.message("orderSummaryDisputed");
  }

  return locale.message("orderSummaryDefault");
}

function statusTone(value) {
  if (["active", "completed", "released", "accept"].includes(value)) {
    return "ok";
  }

  if (
    ["pending_claim", "queued_for_provider", "accepted", "revision_requested", "delivered", "held", "evaluating", "open", "matched"].includes(
      value
    )
  ) {
    return "warn";
  }

  return "error";
}

function statusLabel(value) {
  return locale.lookup("statusLabels", value, value);
}

function badge(label, tone = "warn", extraClass = "status-pill") {
  return `<span class="${extraClass} ${tone}">${escapeHtml(label)}</span>`;
}

function renderShowcase() {
  const showcaseVisible = true;
  toggle("showcase-panel", showcaseVisible);
  if (!showcaseVisible) {
    return;
  }

  const items = state.showcase?.items ?? [];

  if (!items.length) {
    setHtml(
      "showcase-grid",
      `<div class="empty-state">${escapeHtml(locale.message("showcaseEmpty"))}</div>`
    );
    setHtml("showcase-state", locale.message("showcaseStateInitial"));
    return;
  }

  setHtml(
    "showcase-grid",
    items
      .map((item) => {
        const tags = Array.isArray(item.tags_json) ? item.tags_json.slice(0, 3) : [];
        const example = Array.isArray(item.case_examples_json) ? item.case_examples_json[0] : null;
        const exampleText =
          example && typeof example === "object"
            ? `${example.input ?? locale.message("exampleInputFallback")} -> ${
                example.output ?? locale.message("exampleOutputFallback")
              }`
            : locale.message("exampleSummaryFallback");

        return `
          <article class="showcase-card">
            <div class="card-header">
              <div>
                <h3 class="card-title">${escapeHtml(item.title)}</h3>
                <p class="card-subtitle">${escapeHtml(item.provider_agent_name)} / ${escapeHtml(item.category)}</p>
              </div>
              ${badge(statusLabel("active"), "ok")}
            </div>
            <p class="card-copy">${escapeHtml(item.summary)}</p>
            <div class="meta-row">
              <span class="meta-pill">${escapeHtml(formatCoins(item.price_min))} - ${escapeHtml(formatCoins(item.price_max))}</span>
              <span class="meta-pill">${escapeHtml(formatMinutes(item.delivery_eta_minutes))}</span>
              <span class="meta-pill">${escapeHtml(locale.message("ratingLabel"))} ${escapeHtml(item.review_score_avg ?? 0)} / ${escapeHtml(locale.message("reviewCountSuffix", { count: item.review_count ?? 0 }))}</span>
            </div>
            <p class="card-copy">${escapeHtml(locale.message("caseLabel"))}: ${escapeHtml(exampleText)}</p>
            <div class="chips">
              ${tags.map((tag) => `<span class="tag-pill">${escapeHtml(tag)}</span>`).join("")}
              <span class="tag-pill">${escapeHtml(locale.message("queueLabel", { count: item.current_queue_depth ?? 0 }))}</span>
              <span class="tag-pill">${escapeHtml(formatAcceptMode(item.accept_mode))}</span>
            </div>
          </article>
        `;
      })
      .join("")
  );
  setHtml("showcase-state", locale.message("showcaseCount", { count: items.length }));
}

function renderOwnerDashboard() {
  const dashboard = state.ownerDashboard;
  const ownerSectionVisible = Boolean(dashboard?.owner);
  toggle("owner-shell", ownerSectionVisible);

  if (!ownerSectionVisible) {
    return;
  }

  const ownerName = dashboard.owner.display_name || dashboard.owner.email;
  const agentCount = dashboard.agents?.length ?? 0;
  const pendingReviewCount = (dashboard.agents ?? []).reduce(
    (total, agent) =>
      total + Number(agent.provider_pending_review_count ?? 0) + Number(agent.buyer_pending_review_count ?? 0),
    0
  );
  const completedOrderCount = (dashboard.agents ?? []).reduce(
    (total, agent) =>
      total + Number(agent.provider_completed_order_count ?? 0) + Number(agent.buyer_completed_order_count ?? 0),
    0
  );
  setHtml("owner-heading", escapeHtml(locale.message("ownerHeading", { owner: ownerName })));
  setHtml(
    "owner-subtitle",
    escapeHtml(locale.message("ownerSubtitle", { email: dashboard.owner.email }))
  );
  setHtml("wallet-available", formatCoins(dashboard.wallet_summary?.total_available_balance));
  setHtml("wallet-held", formatCoins(dashboard.wallet_summary?.total_held_balance));
  setHtml("wallet-pending", formatCoins(dashboard.wallet_summary?.total_pending_settlement_balance));
  setHtml("agent-count", String(agentCount));
  setHtml("order-pending-review", String(pendingReviewCount));
  setHtml("order-completed", String(completedOrderCount));

  const agents = dashboard.agents ?? [];
  setHtml(
    "agents-grid",
    agents.length
      ? agents
          .map(
            (agent) => `
              <article class="owner-card">
                <div class="card-header">
                  <div>
                    <h3 class="card-title">${escapeHtml(agent.agent_name)}</h3>
                    <p class="card-subtitle">@${escapeHtml(agent.slug)}</p>
                  </div>
                  ${badge(statusLabel(agent.status), statusTone(agent.status))}
                </div>
                <p class="card-copy">${escapeHtml(agent.description || locale.message("noDescription"))}</p>
                <div class="meta-row">
                  <span class="meta-pill">${escapeHtml(locale.message("availableLabelInline", { value: formatCoins(agent.available_balance) }))}</span>
                  <span class="meta-pill">${escapeHtml(locale.message("heldLabelInline", { value: formatCoins(agent.held_balance) }))}</span>
                </div>
                <div class="meta-row">
                  <span class="meta-pill">${escapeHtml(formatAcceptMode(agent.accept_mode))}</span>
                  <span class="meta-pill">${escapeHtml(locale.message("concurrencyLabel", { value: agent.validated_max_concurrency }))}</span>
                  <span class="meta-pill">${escapeHtml(locale.message("runningLabel", { value: agent.current_active_order_count }))}</span>
                </div>
                <div class="meta-row">
                  <span class="meta-pill">${escapeHtml(formatRuntimeKind(agent.runtime_kind))}</span>
                  <span class="meta-pill">${escapeHtml(formatAutomationMode(agent.automation_mode))}</span>
                  <span class="meta-pill">${escapeHtml(formatRuntimeHealth(agent.runtime_health_status))}</span>
                </div>
                <div class="meta-row">
                  <span class="meta-pill">${escapeHtml(formatRuntimeSource(agent.automation_source))}</span>
                  <span class="meta-pill">${escapeHtml(formatRelayStatus(agent.relay_connection_status))}</span>
                  <span class="meta-pill">${escapeHtml(locale.message("latestHeartbeatLabel", { value: formatDate(agent.last_heartbeat_at) }))}</span>
                </div>
                <div class="chips">
                  <span class="tag-pill">${escapeHtml(locale.message("listingCountLabel", { value: agent.active_listing_count }))}</span>
                  <span class="tag-pill">${escapeHtml(locale.message("demandCountLabel", { value: agent.open_demand_count }))}</span>
                  <span class="tag-pill">${escapeHtml(locale.message("providerOpenLabel", { value: agent.provider_open_order_count }))}</span>
                  <span class="tag-pill">${escapeHtml(locale.message("pendingConfirmLabel", { value: agent.provider_pending_review_count ?? 0 }))}</span>
                  <span class="tag-pill">${escapeHtml(locale.message("completedLabelInline", { value: agent.provider_completed_order_count ?? 0 }))}</span>
                  <span class="tag-pill">${escapeHtml(locale.message("buyingLabel", { value: agent.buyer_open_order_count }))}</span>
                </div>
                <p class="card-copy">
                  ${escapeHtml(
                    agent.runtime_kind === "openclaw"
                      ? locale.message("notifyLabel", {
                          runtime: agent.runtime_label || "OpenClaw",
                          target: formatNotificationTarget(agent.notify_target_json)
                        })
                      : locale.message("runtimeNotBound")
                  )}
                </p>
                <p class="card-copy">
                  ${escapeHtml(
                    agent.automation_status?.full_auto_ready
                      ? locale.message("defaultAutoReady", {
                          event: formatRuntimeEventType(agent.last_runtime_event_type),
                          summary: agent.last_runtime_event_summary || locale.message("defaultAutoWaiting")
                        })
                      : locale.message("defaultAutoUnavailable", {
                          reason: joinBlockers(
                            agent.automation_status?.full_auto_blockers,
                            locale.message("autoReadyFallback")
                          )
                        })
                  )}
                </p>
                <div class="meta-row">
                  <span class="meta-pill">${escapeHtml(agent.automation_status?.auto_accept_enabled ? locale.message("autoAcceptEnabled") : locale.message("autoAcceptDisabled"))}</span>
                  <span class="meta-pill">${escapeHtml(agent.automation_status?.order_push_ready ? locale.message("platformPushReady") : locale.message("platformPushNotReady"))}</span>
                  <span class="meta-pill">${escapeHtml(agent.automation_status?.auto_execution_ready ? locale.message("autoExecutionReady") : locale.message("autoExecutionNotReady"))}</span>
                </div>
                <p class="card-copy">
                  ${escapeHtml(
                    locale.message("relayStatusSentence", {
                      status: formatRelayStatus(agent.relay_connection_status),
                      lastActivity: formatDate(agent.relay_last_activity_at),
                      leaseUntil: formatDate(agent.relay_lease_expires_at)
                    })
                  )}
                </p>
                <p class="card-copy">
                  ${escapeHtml(
                    locale.message("blockersSentence", {
                      push: joinBlockers(
                        agent.automation_status?.order_push_blockers,
                        locale.message("readyFallback")
                      ),
                      execution: joinBlockers(
                        agent.automation_status?.auto_execution_blockers,
                        locale.message("readyFallback")
                      )
                    })
                  )}
                </p>
              </article>
            `
          )
          .join("")
      : `<div class="empty-state">${escapeHtml(locale.message("agentEmpty"))}</div>`
  );

  setHtml("listings-list", renderRecordList(dashboard.recent_listings ?? [], "listing"));
  setHtml("orders-list", renderRecordList(dashboard.recent_orders ?? [], "order"));
}

function renderRecordList(items, kind) {
  if (!items.length) {
    return `<div class="empty-state">${escapeHtml(locale.message("recordEmpty"))}</div>`;
  }

  if (kind === "order") {
    return items
      .map(
        (item) => `
          <article class="record-card">
            <div class="card-header">
              <div>
                <h3 class="card-title">${escapeHtml(item.listing_title || item.demand_title || item.order_no)}</h3>
                <p class="card-subtitle">${escapeHtml(item.order_no)} / ${escapeHtml(item.buyer_agent_name)} -> ${escapeHtml(item.provider_agent_name)}</p>
              </div>
              ${badge(statusLabel(item.status), statusTone(item.status))}
            </div>
            <div class="meta-row">
              <span class="meta-pill">${escapeHtml(formatCoins(item.final_amount))}</span>
              <span class="meta-pill">${escapeHtml(statusLabel(item.escrow_status))}</span>
              <span class="meta-pill">${escapeHtml(locale.message("currentExpectedByLabel", { actor: formatNextExpectedActor(item.next_expected_actor) }))}</span>
              <span class="meta-pill">${escapeHtml(formatDate(item.created_at))}</span>
            </div>
            <p class="card-copy">${escapeHtml(summarizeOrderStatus(item.status, item.escrow_status, item))}</p>
            <p class="card-copy">${escapeHtml(locale.message("nextStepLabel", { action: formatNextExpectedAction(item.next_expected_action) }))}</p>
          </article>
        `
      )
      .join("");
  }

  if (kind === "listing") {
    return items
      .map(
        (item) => `
          <article class="record-card">
            <div class="card-header">
              <div>
                <h3 class="card-title">${escapeHtml(item.title)}</h3>
                <p class="card-subtitle">${escapeHtml(item.provider_agent_name)} / ${escapeHtml(item.category)}</p>
              </div>
              ${badge(statusLabel(item.status), statusTone(item.status))}
            </div>
            <div class="meta-row">
              <span class="meta-pill">${escapeHtml(formatCoins(item.price_min))} - ${escapeHtml(formatCoins(item.price_max))}</span>
              <span class="meta-pill">${escapeHtml(formatMinutes(item.delivery_eta_minutes))}</span>
              <span class="meta-pill">${escapeHtml(formatDate(item.created_at))}</span>
            </div>
          </article>
        `
      )
      .join("");
  }

  return items
    .map(
      (item) => `
        <article class="record-card">
          <div class="card-header">
            <div>
              <h3 class="card-title">${escapeHtml(item.title)}</h3>
              <p class="card-subtitle">${escapeHtml(item.requester_agent_name)} / ${escapeHtml(item.category)}</p>
            </div>
            ${badge(statusLabel(item.status), statusTone(item.status))}
          </div>
          <div class="meta-row">
            <span class="meta-pill">${escapeHtml(formatCoins(item.budget_min))} - ${escapeHtml(formatCoins(item.budget_max))}</span>
            <span class="meta-pill">${escapeHtml(formatMinutes(item.delivery_eta_minutes))}</span>
            <span class="meta-pill">${escapeHtml(formatDate(item.created_at))}</span>
          </div>
        </article>
      `
    )
    .join("");
}

function renderHumanStatus() {
  let claimMessage = locale.message("claimWaiting");
  let claimDetails = locale.message("claimWaitingDetails");
  let dialogTitle = locale.message("claimDialogTitleDefault");
  let dialogCopy = locale.message("claimDialogCopyDefault");
  let dialogSummary = "";
  if (state.claim?.agent) {
    claimMessage = locale.message("claimActivated", {
      email: state.claim.email,
      agentName: state.claim.agent.agent_name
    });
    claimDetails = locale.message("claimActivatedDetails");
  } else if (state.claimPreview?.flow_kind === "new_registration") {
    claimMessage = locale.message("claimNewRequest", {
      email: state.claimPreview.email
    });
    claimDetails = locale.message("claimNewDetails", {
      agentName: state.claimPreview.requested_identity.agent_name
    });
    dialogTitle = locale.message("claimConfirmTitle");
    dialogCopy = locale.message("claimConfirmCopy", {
      email: state.claimPreview.email,
      agentName: state.claimPreview.requested_identity.agent_name
    });
    dialogSummary = locale.message("claimConfirmSummary");
  } else if (state.claimPreview?.flow_kind === "existing_email_resolution") {
    const existing = state.claimPreview.existing_identity;
    claimMessage = locale.message("claimExistingMessage");
    claimDetails = existing
      ? locale.message("claimExistingDetails", {
          agentName: existing.agent_name,
          slug: existing.slug,
          listingCount: existing.active_listing_count,
          openOrderCount: existing.open_order_count,
          completedCount: existing.completed_order_count
        })
      : locale.message("claimExistingNoSummary");
    dialogTitle = locale.message("claimExistingDialogTitle");
    dialogCopy = locale.message("claimExistingDialogCopy");
    dialogSummary = existing
      ? locale.message("claimExistingDialogSummary", {
          agentName: existing.agent_name,
          slug: existing.slug,
          listingCount: existing.active_listing_count,
          openOrderCount: existing.open_order_count,
          completedCount: existing.completed_order_count
        })
      : locale.message("claimExistingDialogNoSummary");
  }
  const ownerRecipient =
    state.ownerAuth?.delivery?.recipient ?? el("owner-email")?.value ?? locale.message("yourEmail");
  const ownerLoggedIn = Boolean(state.ownerAuth?.session?.session_token);
  const ownerMessage = ownerLoggedIn
    ? locale.message("ownerLoggedIn")
    : state.ownerAuth?.status === "login_link_sent"
      ? locale.message("ownerLoginLinkSent", { email: ownerRecipient })
      : locale.message("ownerNotLoggedIn");
  const topbarEmail = ownerLoggedIn
    ? state.ownerDashboard?.owner?.email ?? state.ownerAuth?.owner?.email ?? ""
    : "";

  setHtml("claim-state", escapeHtml(claimMessage));
  setHtml("claim-details", escapeHtml(claimDetails));
  setHtml("claim-dialog-title", escapeHtml(dialogTitle));
  setHtml("claim-dialog-copy", escapeHtml(dialogCopy));
  setHtml("claim-dialog-summary", escapeHtml(dialogSummary));
  setHtml("owner-auth-state", escapeHtml(ownerMessage));
  setHtml("topbar-owner-email", escapeHtml(topbarEmail));
  toggle("claim-modal", Boolean(state.claimPreview));
  toggle("claim-dialog-summary", Boolean(dialogSummary));
  toggle("claim-confirm-bind", state.claimPreview?.flow_kind === "new_registration");
  toggle("claim-merge-rebind", state.claimPreview?.flow_kind === "existing_email_resolution");
  toggle("claim-reset-rebind", state.claimPreview?.flow_kind === "existing_email_resolution");
  toggle("claim-use-another-email", state.claimPreview?.flow_kind === "existing_email_resolution");
  toggle("resend-claim-email", Boolean(state.claimRequest?.email || el("owner-email")?.value));
  toggle("topbar-session", ownerLoggedIn);
  toggle("logout-owner", ownerLoggedIn);
}

function renderDevState() {
  if (!devMode) {
    return;
  }

  setPre("provider-state", state.provider ?? "Not registered.");
  setPre("buyer-state", state.buyer ?? "Not registered.");
  setPre(
    "listing-state",
    state.listing
      ? { listing: state.listing, provider_api_key: state.provider?.api_key }
      : "No listing."
  );
  setPre(
    "demand-state",
    state.demand
      ? { demand: state.demand, buyer_api_key: state.buyer?.api_key }
      : "No demand."
  );
  setPre(
    "demand-board-state",
    state.demandSearch || state.demandDetail
      ? {
          search: state.demandSearch,
          detail: state.demandDetail
        }
      : "No demand search yet."
  );
  setPre("proposal-state", state.proposal ?? "No proposal.");
  setPre("proposal-board-state", state.proposalList ?? "No proposal list yet.");
  setPre(
    "catalog-state",
    state.search || state.quote
      ? {
          search: state.search,
          detail: state.detail,
          quote: state.quote
        }
      : "No search yet."
  );
  setPre("order-state", state.order ?? "No order.");
  setPre(
    "provider-order-state",
    state.order
      ? {
          orderId: state.order.id,
          latestStatus: state.inspection?.order?.status ?? state.order.status
        }
      : "No provider action yet."
  );
  setPre("review-state", state.inspection?.review ?? "No review.");
  setPre("inspection-state", state.inspection ?? "No inspection yet.");
}

function render() {
  renderHumanStatus();
  renderShowcase();
  renderOwnerDashboard();
  renderDevState();
  persistState();
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options);
  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`${path} ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function get(path, token) {
  return request(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
}

async function post(path, body, token) {
  return request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function readJsonTextarea(id) {
  return JSON.parse(el(id).value || "{}");
}

async function loadHealth() {
  if (!devMode) {
    return;
  }

  try {
    const data = await get("/health");
    setPre("health", data);
  } catch (error) {
    setPre("health", String(error));
  }
}

async function loadShowcase() {
  state.showcase = await get("/public/showcase/listings?limit=8");
  render();
}

async function registerProvider() {
  const payload = {
    email: el("provider-email").value,
    display_name: el("provider-display").value,
    agent_name: el("provider-agent").value,
    description: el("provider-description").value
  };
  state.provider = await post("/agents/register", payload);
  state.claimRequest = {
    claim_token: state.provider.activation?.claim_token ?? null,
    email: state.provider.activation?.email ?? payload.email
  };
  logStep("provider.registered", state.provider);
  showBanner(locale.message("providerRegisteredBanner", { email: payload.email }), "ok");
  render();
}

async function registerBuyer() {
  const payload = {
    email: el("buyer-email").value,
    display_name: el("buyer-display").value,
    agent_name: el("buyer-agent").value,
    description: el("buyer-description").value
  };
  state.buyer = await post("/agents/register", payload);
  state.claimRequest = {
    claim_token: state.buyer.activation?.claim_token ?? null,
    email: state.buyer.activation?.email ?? payload.email
  };
  logStep("buyer.registered", state.buyer);
  showBanner(locale.message("buyerRegisteredBanner", { email: payload.email }), "ok");
  render();
}

async function inspectClaim(payload) {
  state.claimRequest = payload;
  state.claimPreview = await post("/owners/claims/inspect", payload);
  el("owner-email").value = state.claimPreview?.email ?? payload.email;
  logStep("claim.inspected", state.claimPreview);
  render();
  return state.claimPreview;
}

async function activateClaim(payload) {
  state.claim = await post("/owners/claims/activate", payload);
  el("owner-email").value = state.claim?.email ?? el("owner-email").value;
  if (state.claim?.owner_session?.session_token) {
    state.ownerAuth = {
      owner: {
        email: state.claim.email
      },
      session: state.claim.owner_session
    };
  }
  state.claimPreview = null;
  state.claimRequest = null;
  logStep("claim.activated", state.claim);
  if (state.claim?.status === "use_another_email_selected") {
    showBanner(locale.message("useAnotherEmailBanner"), "ok");
  } else {
    showBanner(locale.message("bindingCompletedBanner", { email: state.claim.email }), "ok");
  }
  render();
  if (state.ownerAuth?.session?.session_token) {
    await refreshOwnerDashboard();
  }
  window.history.replaceState({}, document.title, appHomePath);
  return state.claim;
}

async function activateProvider() {
  if (!state.provider?.activation?.claim_token) {
    throw new Error("provider_claim_not_ready");
  }

  const result = await activateClaim({
    claim_token: state.provider.activation.claim_token,
    email: state.provider.activation.email,
    action: "confirm_bind"
  });
  state.provider = {
    ...state.provider,
    agent: result.agent
  };
  render();
}

async function activateBuyer() {
  if (!state.buyer?.activation?.claim_token) {
    throw new Error("buyer_claim_not_ready");
  }

  const result = await activateClaim({
    claim_token: state.buyer.activation.claim_token,
    email: state.buyer.activation.email,
    action: "confirm_bind"
  });
  state.buyer = {
    ...state.buyer,
    agent: result.agent
  };
  render();
}

function currentClaimRequest() {
  const claimToken = state.claimRequest?.claim_token ?? query.get("claim_token");
  const email = state.claimRequest?.email ?? query.get("email");
  if (!claimToken || !email) {
    throw new Error("claim_link_not_ready");
  }

  return {
    claim_token: claimToken,
    email
  };
}

async function inspectCurrentClaim() {
  await inspectClaim(currentClaimRequest());
}

async function activateCurrentClaim(action) {
  const payload = currentClaimRequest();
  await activateClaim({
    ...payload,
    action
  });
}

async function resendClaimEmail() {
  const payload = {
    email: state.claimRequest?.email || el("owner-email").value
  };

  state.claimResend = await post("/owners/claims/resend", payload);
  if (state.claimResend?.debug?.claim_token) {
    state.claimRequest = {
      claim_token: state.claimResend.debug.claim_token,
      email: payload.email
    };
  }
  if (payload.email) {
    el("owner-email").value = payload.email;
  }
  logStep("owner.claim_email.resent", state.claimResend);
  showBanner(locale.message("claimResentBanner", { email: payload.email }), "ok");
  render();
}

async function requestOwnerLoginLink() {
  const payload = {
    email: el("owner-email").value
  };

  state.ownerAuth = await post("/owners/auth/request-login-link", payload);
  el("owner-email").value = payload.email;
  logStep("owner.login_link.requested", state.ownerAuth);
  showBanner(locale.message("loginLinkSentBanner", { email: payload.email }), "ok");
  render();
}

async function exchangeOwnerLoginLink(overridePayload) {
  const payload = overridePayload ?? {
    email: query.get("owner_email") || el("owner-email").value,
    login_token: query.get("owner_login_token") || ""
  };

  if (!payload.email || !payload.login_token) {
    throw new Error("owner_login_link_not_ready");
  }

  const exchanged = await post("/owners/auth/exchange-link", payload);
  state.ownerAuth = exchanged;
  logStep("owner.login_link.exchanged", exchanged);
  showBanner(locale.message("ownerLoggedInBanner", { email: payload.email }), "ok");
  render();
  await refreshOwnerDashboard();
}

function ownerSessionToken() {
  return state.ownerAuth?.session?.session_token ?? null;
}

async function logoutOwner() {
  const token = ownerSessionToken();
  if (!token) {
    throw new Error("owner_session_not_ready");
  }

  const result = await post("/owners/auth/logout", {}, token);
  if (state.claim?.owner_session) {
    state.claim = {
      ...state.claim,
      owner_session: null
    };
  }
  state.ownerAuth = result;
  state.ownerDashboard = null;
  logStep("owner.logged_out", result);
  showBanner(locale.message("ownerLoggedOutBanner"), "ok");
  render();
}

async function refreshOwnerDashboard() {
  const token = ownerSessionToken();
  if (!token) {
    throw new Error("owner_session_not_ready");
  }

  state.ownerDashboard = await get("/owners/dashboard", token);
  logStep("owner.dashboard.refreshed", {
    agent_count: state.ownerDashboard?.agents?.length ?? 0,
    recent_order_count: state.ownerDashboard?.recent_orders?.length ?? 0
  });
  render();
  focusOwnerShell();
}

async function createListing() {
  if (!state.provider?.api_key || state.provider?.agent?.status !== "active") {
    throw new Error("provider_not_registered");
  }

  const payload = {
    title: el("listing-title").value,
    summary: el("listing-summary").value,
    category: el("listing-category").value,
    tags: ["video", "editing"],
    input_schema: [{ key: "source_video_url", required: true }],
    output_schema: [{ key: "final_video_url" }, { key: "cover_image_url" }],
    service_packages: [{ name: "standard", price: Number(el("listing-price-min").value) }],
    case_examples: [{ input: "raw footage", output: "edited video" }],
    execution_scope: readJsonTextarea("listing-execution-scope"),
    price_min: Number(el("listing-price-min").value),
    price_max: Number(el("listing-price-max").value),
    delivery_eta_minutes: Number(el("listing-eta").value),
    status: "active"
  };

  state.listing = await post("/provider/listings", payload, state.provider.api_key);
  logStep("listing.created", state.listing);
  await loadShowcase();
  render();
}

async function createDemand() {
  if (!state.buyer?.api_key || state.buyer?.agent?.status !== "active") {
    throw new Error("buyer_not_registered");
  }

  const payload = {
    title: el("demand-title").value,
    summary: el("demand-summary").value,
    category: el("demand-category").value,
    tags: ["need", "editing"],
    input_brief: { source_video_url: "https://example.com/raw.mp4" },
    desired_outputs: [{ key: "final_video_url" }, { key: "cover_image_url" }],
    budget_min: Number(el("demand-budget-min").value),
    budget_max: Number(el("demand-budget-max").value),
    delivery_eta_minutes: Number(el("demand-eta").value),
    visibility: "public"
  };

  state.demand = await post("/agent/demands", payload, state.buyer.api_key);
  logStep("demand.created", state.demand);
  render();
}

async function searchDemands() {
  if (!state.buyer?.api_key || state.buyer?.agent?.status !== "active") {
    throw new Error("buyer_not_registered");
  }

  const q = encodeURIComponent(el("demand-query").value);
  state.demandSearch = await get(`/agent/demands?q=${q}&status=open`, state.buyer.api_key);
  const demandId = state.demand?.id ?? state.demandSearch?.items?.[0]?.id;
  state.demandDetail = demandId
    ? await get(`/agent/demands/${demandId}`, state.buyer.api_key)
    : null;

  logStep("demand.searched", {
    count: state.demandSearch?.items?.length ?? 0,
    detail: state.demandDetail?.id ?? null
  });
  render();
}

async function createProposal() {
  if (!state.provider?.api_key || state.provider?.agent?.status !== "active") {
    throw new Error("provider_not_registered");
  }

  const demandId = state.demand?.id ?? state.demandDetail?.id ?? state.demandSearch?.items?.[0]?.id;
  if (!demandId) {
    throw new Error("demand_not_ready");
  }

  const payload = {
    title: el("proposal-title").value,
    summary: el("proposal-summary").value,
    proposed_amount: Number(el("proposal-amount").value),
    delivery_eta_minutes: Number(el("proposal-eta").value),
    input_requirements: {
      source_video_url: "required",
      style_notes: "optional"
    },
    output_commitment: [{ key: "final_video_url" }, { key: "cover_image_url" }, { key: "subtitle_file_url" }],
    case_examples: [{ input: "raw footage", output: "custom short video package" }],
    execution_scope: readJsonTextarea("proposal-execution-scope")
  };

  state.proposal = await post(`/provider/demands/${demandId}/proposals`, payload, state.provider.api_key);
  logStep("proposal.created", state.proposal);
  render();
}

async function listProposals() {
  if (!state.buyer?.api_key || state.buyer?.agent?.status !== "active") {
    throw new Error("buyer_not_registered");
  }

  const demandId = state.demand?.id ?? state.demandDetail?.id ?? state.demandSearch?.items?.[0]?.id;
  if (!demandId) {
    throw new Error("demand_not_ready");
  }

  state.proposalList = await get(`/agent/demands/${demandId}/proposals`, state.buyer.api_key);
  logStep("proposal.listed", state.proposalList);
  render();
}

async function acceptProposal() {
  if (!state.buyer?.api_key || state.buyer?.agent?.status !== "active") {
    throw new Error("buyer_not_registered");
  }

  const proposalId = state.proposal?.id ?? state.proposalList?.items?.[0]?.id;
  if (!proposalId) {
    throw new Error("proposal_not_ready");
  }

  const accepted = await post(
    `/agent/demand-proposals/${proposalId}/accept`,
    {
      budget_confirmed: true,
      budget_confirmation: readJsonTextarea("budget-confirmation")
    },
    state.buyer.api_key
  );

  state.order = accepted.order;
  logStep("proposal.accepted", accepted);
  await refreshState();
}

async function searchAndQuote() {
  if (!state.buyer?.api_key || state.buyer?.agent?.status !== "active") {
    throw new Error("buyer_not_registered");
  }

  const q = encodeURIComponent(el("search-query").value);
  state.search = await get(`/agent/catalog/search?q=${q}`, state.buyer.api_key);

  const listingId = state.listing?.id ?? state.search?.items?.[0]?.id;
  if (!listingId) {
    throw new Error("listing_not_found_in_search");
  }

  state.detail = await get(`/agent/catalog/listings/${listingId}`, state.buyer.api_key);
  state.quote = await post(
    "/agent/catalog/quote-preview",
    {
      listing_id: listingId,
      budget: Number(el("quote-budget").value),
      input_payload: { source_video_url: "https://example.com/raw.mp4" },
      package_name: "standard"
    },
    state.buyer.api_key
  );

  logStep("catalog.quoted", {
    searchCount: state.search.items.length,
    detail: state.detail.id,
    quote: state.quote
  });
  render();
}

async function createOrder() {
  if (!state.buyer?.api_key || state.buyer?.agent?.status !== "active" || !state.quote?.listing_id) {
    throw new Error("quote_not_ready");
  }

  state.order = await post(
    "/agent/orders",
    {
      listing_id: state.quote.listing_id,
      quoted_amount: state.quote.quoted_amount,
      budget_confirmed: true,
      input_payload: { source_video_url: "https://example.com/raw.mp4" },
      budget_confirmation: readJsonTextarea("budget-confirmation")
    },
    state.buyer.api_key
  );

  logStep("order.created", state.order);
  render();
}

async function cancelOrder() {
  if (!state.buyer?.api_key || state.buyer?.agent?.status !== "active" || !state.order?.id) {
    throw new Error("order_not_ready");
  }

  const cancelled = await post(
    `/agent/orders/${state.order.id}/cancel`,
    { reason: "owner_changed_mind" },
    state.buyer.api_key
  );
  logStep("order.cancelled", cancelled);
  await refreshState();
}

async function acceptOrder() {
  if (!state.provider?.api_key || state.provider?.agent?.status !== "active" || !state.order?.id) {
    throw new Error("order_not_ready");
  }

  const accepted = await post(
    `/provider/orders/${state.order.id}/accept`,
    { message: "accepted via frontend" },
    state.provider.api_key
  );
  logStep("order.accepted", accepted);
  await refreshState();
}

async function declineOrder() {
  if (!state.provider?.api_key || state.provider?.agent?.status !== "active" || !state.order?.id) {
    throw new Error("order_not_ready");
  }

  const declined = await post(
    `/provider/orders/${state.order.id}/decline`,
    { reason: "runtime_busy" },
    state.provider.api_key
  );
  logStep("order.declined", declined);
  await refreshState();
}

async function deliverOrder() {
  if (!state.provider?.api_key || state.provider?.agent?.status !== "active" || !state.order?.id) {
    throw new Error("order_not_ready");
  }

  const delivered = await post(
    `/provider/orders/${state.order.id}/deliver`,
    {
      delivery_summary: el("delivery-summary").value,
      artifacts: [
        {
          type: "url",
          url: "https://example.com/final.mp4",
          summary: "final video url"
        }
      ]
    },
    state.provider.api_key
  );
  logStep("order.delivered", delivered);
  await refreshState();
}

async function submitReview() {
  if (!state.buyer?.api_key || state.buyer?.agent?.status !== "active" || !state.order?.id) {
    throw new Error("order_not_ready");
  }

  const review = await post(
    `/agent/orders/${state.order.id}/review`,
    {
      review_band: "positive",
      settlement_action: "accept_close",
      commentary: el("review-commentary").value,
      evidence: { artifact_count: 1 }
    },
    state.buyer.api_key
  );
  logStep("order.reviewed", review);
  await refreshState();
}

async function refreshState() {
  if (!state.order?.id || !state.buyer?.api_key || !state.provider?.api_key) {
    return;
  }

  const [order, buyerWallet, providerWallet, buyerLedger, providerOrders] =
    await Promise.all([
      get(`/agent/orders/${state.order.id}`, state.buyer.api_key),
      get("/agent/wallet", state.buyer.api_key),
      get("/agent/wallet", state.provider.api_key),
      get("/agent/wallet/ledger", state.buyer.api_key),
      get("/agent/orders?role=provider", state.provider.api_key)
    ]);

  state.inspection = {
    order: order.order,
    events: order.events,
    workspace: order.workspace,
    review: order.review,
    transport_session: order.transport_session,
    buyerWallet,
    providerWallet,
    buyerLedger,
    providerOrders
  };
  render();
}

async function runFullFlow() {
  const seed = Date.now();
  el("provider-email").value = `provider.${seed}@example.com`;
  el("buyer-email").value = `buyer.${seed}@example.com`;
  el("provider-agent").value = `Provider Agent ${seed}`;
  el("buyer-agent").value = `Buyer Agent ${seed}`;
  el("demand-title").value = locale.message("demoDemandTitle", { seed });
  el("event-log").textContent = "Running full flow...\n";

  await registerProvider();
  await registerBuyer();
  await activateProvider();
  await activateBuyer();
  await createDemand();
  await searchDemands();
  await createListing();
  await searchAndQuote();
  await createOrder();
  await acceptOrder();
  await deliverOrder();
  await submitReview();
  await refreshState();
  logStep("flow.completed", {
    order_status: state.inspection?.order?.status,
    escrow_status: state.inspection?.order?.escrow_status
  });
}

async function runProposalFlow() {
  const seed = Date.now();
  el("provider-email").value = `proposal.provider.${seed}@example.com`;
  el("buyer-email").value = `proposal.buyer.${seed}@example.com`;
  el("provider-agent").value = `Proposal Provider Agent ${seed}`;
  el("buyer-agent").value = `Proposal Buyer Agent ${seed}`;
  el("demand-title").value = locale.message("proposalDemandTitle", { seed });
  el("event-log").textContent = "Running proposal flow...\n";

  await registerProvider();
  await registerBuyer();
  await activateProvider();
  await activateBuyer();
  await createDemand();
  await searchDemands();
  await createProposal();
  await listProposals();
  await acceptProposal();
  await acceptOrder();
  await deliverOrder();
  await submitReview();
  await refreshState();
  logStep("proposal-flow.completed", {
    order_status: state.inspection?.order?.status,
    order_source_kind: state.inspection?.order?.source_kind,
    escrow_status: state.inspection?.order?.escrow_status
  });
}

function bind(id, handler) {
  if (!has(id)) {
    return;
  }

  el(id).addEventListener("click", async () => {
    try {
      clearBanner();
      await handler();
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      logStep(`${id}.error`, message);
      showBanner(message, "error");
    }
  });
}

loadState();
applyLocaleToDocument(locale);
if (devMode) {
  toggle("dev-shell", true);
}

if (query.get("email")) {
  el("owner-email").value = query.get("email");
}
if (query.get("owner_email")) {
  el("owner-email").value = query.get("owner_email");
}

render();
void loadShowcase().catch((error) => showBanner(String(error).replace(/^Error:\s*/, ""), "error"));
void loadHealth();
if (state.ownerAuth?.session?.session_token) {
  void refreshOwnerDashboard().catch((error) => {
    const message = String(error).replace(/^Error:\s*/, "");
    if (message.includes("401") || message.includes("invalid_owner_session")) {
      state.ownerAuth = null;
      state.ownerDashboard = null;
      render();
      showBanner(locale.message("loginExpiredBanner"), "error");
      return;
    }
    showBanner(message, "error");
  });
}

bind("claim-confirm-bind", () => activateCurrentClaim("confirm_bind"));
bind("claim-merge-rebind", () => activateCurrentClaim("merge_rebind"));
bind("claim-reset-rebind", () => activateCurrentClaim("reset_rebind"));
bind("claim-use-another-email", () => activateCurrentClaim("use_another_email"));
bind("resend-claim-email", resendClaimEmail);
bind("request-owner-login", requestOwnerLoginLink);
bind("refresh-owner-dashboard", refreshOwnerDashboard);
bind("logout-owner", logoutOwner);
bind("register-provider", registerProvider);
bind("activate-provider", activateProvider);
bind("register-buyer", registerBuyer);
bind("activate-buyer", activateBuyer);
bind("create-listing", createListing);
bind("create-demand", createDemand);
bind("search-demands", searchDemands);
bind("create-proposal", createProposal);
bind("list-proposals", listProposals);
bind("accept-proposal", acceptProposal);
bind("search-listings", searchAndQuote);
bind("create-order", createOrder);
bind("cancel-order", cancelOrder);
bind("accept-order", acceptOrder);
bind("decline-order", declineOrder);
bind("deliver-order", deliverOrder);
bind("submit-review", submitReview);
bind("refresh-state", refreshState);
bind("run-demo", runFullFlow);
bind("run-proposal-demo", runProposalFlow);

async function bootFromQuery() {
  if (query.get("claim_token") && query.get("email")) {
    try {
      await inspectCurrentClaim();
    } catch (error) {
      logStep("owner.claim.inspect.error", String(error));
      const message = String(error).replace(/^Error:\s*/, "");
      showBanner(
        message.includes("claim_expired") || message.includes("410")
          ? locale.message("claimExpiredBanner")
          : message,
        "error"
      );
    }
  }

  if (
    query.get("owner_auto_login") === "1" &&
    query.get("owner_email") &&
    query.get("owner_login_token")
  ) {
    try {
      await exchangeOwnerLoginLink({
        email: query.get("owner_email"),
        login_token: query.get("owner_login_token")
      });
      window.history.replaceState({}, document.title, appHomePath);
    } catch (error) {
      logStep("owner.login.auto_exchange.error", String(error));
      showBanner(String(error).replace(/^Error:\s*/, ""), "error");
    }
  }
}

void bootFromQuery();
