const KIMI_UA_RULE_ID = 9000;
const ANTHROPIC_NET_RULE_ID = 9001;
const ANTHROPIC_OAUTH_NET_RULE_ID = 9002;

export async function installProviderNetRequestRules(): Promise<void> {
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
}
