const KIMI_UA_RULE_ID = 9000;
const ANTHROPIC_NET_RULE_ID = 9001;
const ANTHROPIC_OAUTH_NET_RULE_ID = 9002;
export const PROVIDER_DNR_RULES_INSTALLED_KEY = 'glideProviderDnrRulesInstalled';

export async function invalidateProviderNetRequestRulesCache(): Promise<void> {
  try {
    await chrome.storage.session.remove(PROVIDER_DNR_RULES_INSTALLED_KEY);
  } catch {
    // session storage may be unavailable in some contexts
  }
}

export async function installProviderNetRequestRules(): Promise<void> {
  try {
    const cached = await chrome.storage.session.get([PROVIDER_DNR_RULES_INSTALLED_KEY]);
    if (cached?.[PROVIDER_DNR_RULES_INSTALLED_KEY] === true) return;
  } catch {
    // proceed without cache
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [KIMI_UA_RULE_ID, ANTHROPIC_NET_RULE_ID, ANTHROPIC_OAUTH_NET_RULE_ID],
    addRules: [
      {
        id: KIMI_UA_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            {
              header: 'User-Agent',
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: 'claude-code/1.0',
            },
          ],
        },
        condition: {
          urlFilter: '||api.kimi.com',
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
        },
      },
      {
        id: ANTHROPIC_NET_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            // Strip browser CORS fingerprints so Anthropic treats MV3 SW calls as
            // server-side OAuth (no dangerous-direct-browser-access required).
            {
              header: 'Origin',
              operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
            },
            {
              header: 'Referer',
              operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
            },
            {
              header: 'User-Agent',
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: 'claude-cli/2.1.108 (external, cli)',
            },
          ],
        },
        condition: {
          urlFilter: '||api.anthropic.com',
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
        },
      },
      {
        id: ANTHROPIC_OAUTH_NET_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            // OAuth token refresh runs from the MV3 SW; strip browser CORS
            // fingerprints so console.anthropic.com accepts it as a CLI call.
            {
              header: 'Origin',
              operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
            },
            {
              header: 'Referer',
              operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
            },
          ],
        },
        condition: {
          urlFilter: '||console.anthropic.com',
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
        },
      },
    ],
  });

  try {
    await chrome.storage.session.set({ [PROVIDER_DNR_RULES_INSTALLED_KEY]: true });
  } catch {
    // ignore — rules are installed even if the cache write fails
  }
}
