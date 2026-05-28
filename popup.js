// popup.js — manages the per-domain enable/disable UI

function getDomainFromUrl(url) {
  try { return new URL(url).host; } catch { return null; }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentDomain = tab && tab.url ? getDomainFromUrl(tab.url) : null;
  const isHttp = tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'));

  const domainEl = document.getElementById('currentDomain');
  const toggleEl = document.getElementById('currentToggle');

  const resp = await chrome.runtime.sendMessage({ type: 'GET_ALL_DOMAINS' });
  // allDomains: { 'hostname:port': true|false }
  const allDomains = resp && resp.domains ? resp.domains : {};

  if (!isHttp || !currentDomain) {
    domainEl.textContent = 'Not available on this page';
    domainEl.classList.add('unavailable');
    toggleEl.disabled = true;
  } else {
    domainEl.textContent = currentDomain;
    toggleEl.checked = allDomains[currentDomain] === true;

    toggleEl.addEventListener('change', async () => {
      const enabled = toggleEl.checked;
      await chrome.runtime.sendMessage({ type: 'SET_DOMAIN_STATUS', domain: currentDomain, enabled });
      allDomains[currentDomain] = enabled;
      renderSavedList(allDomains, currentDomain);
    });
  }

  renderSavedList(allDomains, currentDomain);
}

function renderSavedList(allDomains, currentDomain) {
  const listEl    = document.getElementById('domainList');
  const sectionEl = document.getElementById('savedSection');

  // Show all saved domains (enabled or paused) except the current site row.
  const otherDomains = Object.keys(allDomains).filter(d => d !== currentDomain);

  if (!otherDomains.length) {
    sectionEl.style.display = 'none';
    return;
  }

  sectionEl.style.display = '';
  listEl.innerHTML = '';

  otherDomains.forEach(domain => {
    const row = document.createElement('div');
    row.className = 'domain-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'domain-name';
    nameEl.textContent = domain;
    nameEl.title = domain;

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const label = document.createElement('label');
    label.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = allDomains[domain] === true;
    const sliderEl = document.createElement('span');
    sliderEl.className = 'slider';
    label.appendChild(input);
    label.appendChild(sliderEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.title = 'Remove';
    delBtn.textContent = '✕';

    // Toggle pauses/resumes — domain stays in list either way.
    input.addEventListener('change', async () => {
      const enabled = input.checked;
      await chrome.runtime.sendMessage({ type: 'SET_DOMAIN_STATUS', domain, enabled });
      allDomains[domain] = enabled;
    });

    // Delete removes the domain from the list entirely.
    delBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'DELETE_DOMAIN', domain });
      delete allDomains[domain];
      row.remove();
      const remaining = listEl.querySelectorAll('.domain-row').length;
      sectionEl.style.display = remaining ? '' : 'none';
    });

    actions.appendChild(label);
    actions.appendChild(delBtn);
    row.appendChild(nameEl);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

init();
