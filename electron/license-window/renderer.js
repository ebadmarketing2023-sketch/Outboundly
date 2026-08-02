const banner = document.getElementById("banner");
const errorEl = document.getElementById("error");
const input = document.getElementById("licenseKeyInput");
const activateButton = document.getElementById("activateButton");
const quitButton = document.getElementById("quitButton");

function showBanner(text) {
  banner.textContent = text;
  banner.style.display = "block";
}

function showError(text) {
  errorEl.textContent = text;
  errorEl.style.display = "block";
}

function clearError() {
  errorEl.style.display = "none";
  errorEl.textContent = "";
}

async function init() {
  const status = await window.licenseGate.getInitialStatus();
  if (status.outcome === "blocked") {
    showBanner(status.reason);
  }
}

activateButton.addEventListener("click", async () => {
  const licenseKey = input.value.trim();
  if (!licenseKey) {
    showError("Enter a license key first.");
    return;
  }
  clearError();
  activateButton.disabled = true;
  activateButton.textContent = "Activating…";
  try {
    const result = await window.licenseGate.activate(licenseKey);
    if (!result.ok) {
      showError(result.reason);
    }
    // On success the main process closes this window itself -- nothing further to do here.
  } finally {
    activateButton.disabled = false;
    activateButton.textContent = "Activate";
  }
});

quitButton.addEventListener("click", () => {
  window.licenseGate.quit();
});

void init();
