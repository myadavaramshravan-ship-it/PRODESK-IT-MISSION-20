const tokenKey = "nexus-auth-token";
const authPanel = document.querySelector("#auth-panel");
const dashboard = document.querySelector("#dashboard");
const authForm = document.querySelector("#auth-form");
const authMessage = document.querySelector("#auth-message");
const invoiceDialog = document.querySelector("#invoice-dialog");
const invoiceForm = document.querySelector("#invoice-form");
let mode = "login";

document.querySelector("#year").textContent = new Date().getFullYear();
document.querySelector("#login-tab").addEventListener("click", () => setMode("login"));
document.querySelector("#register-tab").addEventListener("click", () => setMode("register"));
document.querySelector("#logout-button").addEventListener("click", logout);
document.querySelector("#new-invoice-button").addEventListener("click", () => invoiceDialog.showModal());
document.querySelector("#close-dialog").addEventListener("click", () => invoiceDialog.close());

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authMessage.textContent = "";
  const body = Object.fromEntries(new FormData(authForm));
  const response = await request(`/api/auth/${mode === "login" ? "login" : "register"}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    authMessage.textContent = (await response.json()).error || "Unable to sign in.";
    return;
  }
  const data = await response.json();
  sessionStorage.setItem(tokenKey, data.token);
  await showDashboard(data.user);
});

invoiceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = document.querySelector("#create-invoice-button");
  submit.disabled = true;
  const body = Object.fromEntries(new FormData(invoiceForm));
  body.amount = Number(body.amount);
  if (!body.dueDate) delete body.dueDate;
  try {
    const response = await api("/api/invoices", { method: "POST", body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to create invoice.");
    invoiceDialog.close();
    invoiceForm.reset();
    await loadInvoices();
  } catch (error) {
    document.querySelector("#invoice-message").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

async function request(url, options = {}) {
  return fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
}

async function api(url, options = {}) {
  const response = await request(url, {
    ...options,
    headers: { Authorization: `Bearer ${sessionStorage.getItem(tokenKey)}`, ...options.headers }
  });
  if (response.status === 401) logout();
  return response;
}

async function showDashboard(user) {
  authPanel.hidden = true;
  dashboard.hidden = false;
  document.querySelector("#account-actions").hidden = false;
  document.querySelector("#welcome").textContent = user.name;
  await loadInvoices();
}

async function loadInvoices() {
  const response = await api("/api/invoices");
  if (!response.ok) {
    showNotice("Invoices could not be loaded. Please try again.");
    return null;
  }
  const { invoices } = await response.json();
  const list = document.querySelector("#invoice-list");
  list.replaceChildren();
  document.querySelector("#empty-state").hidden = invoices.length > 0;
  for (const invoice of invoices) list.append(makeInvoiceCard(invoice));
  return invoices;
}

function makeInvoiceCard(invoice) {
  const card = document.createElement("article");
  card.className = "invoice-card";
  const details = document.createElement("div");
  const title = document.createElement("div");
  title.className = "invoice-title";
  title.textContent = invoice.description;
  const number = document.createElement("div");
  number.className = "invoice-number";
  number.textContent = invoice.number;
  details.append(title, number);

  const amount = document.createElement("div");
  amount.className = "invoice-amount";
  amount.textContent = new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency.toUpperCase() }).format(invoice.amount);
  const status = document.createElement("span");
  status.className = `status status-${invoice.status.toLowerCase()}`;
  status.textContent = invoice.status;
  const actions = document.createElement("div");
  actions.className = "invoice-actions";
  if (invoice.status === "Unpaid") {
    const pay = document.createElement("button");
    pay.className = "button button-primary";
    pay.type = "button";
    pay.textContent = "Pay invoice";
    pay.addEventListener("click", () => startCheckout(invoice.id, pay));
    actions.append(pay);
  } else if (invoice.receiptAvailable) {
    const receipt = document.createElement("button");
    receipt.className = "button button-quiet";
    receipt.type = "button";
    receipt.textContent = "Download receipt";
    receipt.addEventListener("click", () => downloadReceipt(invoice.id));
    actions.append(receipt);
  }
  const date = document.createElement("div");
  date.className = "invoice-date";
  date.textContent = invoice.dueDate ? `Due ${new Date(`${invoice.dueDate}T00:00:00`).toLocaleDateString()}` : "No due date";
  card.append(details, amount, status, actions, date);
  return card;
}

async function startCheckout(invoiceId, button) {
  button.disabled = true;
  try {
    const response = await api(`/api/invoices/${invoiceId}/checkout`, { method: "POST", body: "{}" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to start payment.");
    window.location.assign(data.checkoutUrl);
  } catch (error) {
    showNotice(error.message);
    button.disabled = false;
  }
}

async function downloadReceipt(invoiceId) {
  const response = await api(`/api/invoices/${invoiceId}/receipt`);
  if (!response.ok) {
    showNotice("Receipt is not available yet. Refresh after payment is confirmed.");
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `receipt-${invoiceId}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

function showNotice(message) {
  const notice = document.querySelector("#notice");
  notice.textContent = message;
  notice.hidden = false;
}

function logout() {
  sessionStorage.removeItem(tokenKey);
  window.location.assign("/");
}

function setMode(nextMode) {
  mode = nextMode;
  const isRegister = mode === "register";
  document.querySelector("#name-label").hidden = !isRegister;
  document.querySelector("#name").hidden = !isRegister;
  document.querySelector("#name").required = isRegister;
  document.querySelector("#password").autocomplete = isRegister ? "new-password" : "current-password";
  document.querySelector("#auth-submit").textContent = isRegister ? "Create account" : "Sign in";
  document.querySelector("#login-tab").classList.toggle("active", !isRegister);
  document.querySelector("#register-tab").classList.toggle("active", isRegister);
  document.querySelector("#login-tab").setAttribute("aria-selected", String(!isRegister));
  document.querySelector("#register-tab").setAttribute("aria-selected", String(isRegister));
  authMessage.textContent = "";
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const paymentComplete = params.get("payment") === "complete";
  if (paymentComplete) {
    showNotice("Payment confirmation is being processed. Your receipt will appear here once verified.");
    history.replaceState({}, "", "/");
  } else if (params.get("payment") === "cancelled") {
    showNotice("Payment was cancelled. Your invoice remains unpaid.");
    history.replaceState({}, "", "/");
  }

  const token = sessionStorage.getItem(tokenKey);
  if (!token) return;
  const response = await api("/api/me");
  if (!response.ok) return;
  const data = await response.json();
  await showDashboard(data.user);
  if (paymentComplete) await waitForPaymentConfirmation();
}

async function waitForPaymentConfirmation() {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const invoices = await loadInvoices();
    if (invoices?.some((invoice) => invoice.status === "Paid")) {
      showNotice("Payment confirmed. Your invoice is marked paid.");
      return;
    }
  }
  showNotice("Payment is still awaiting confirmation from Stripe. Check back shortly or refresh this page.");
}

boot().catch(() => showNotice("Unable to load your billing workspace."));
