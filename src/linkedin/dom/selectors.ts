export const domSelectors = {
  conversationContainers: [
    '[aria-label*="conversation" i][role="list"]',
    '.msg-conversations-container__conversations-list',
    'main ul:has(a[href*="/messaging/thread/"])',
  ],
  conversationRows: [
    'a[href*="/messaging/thread/"]',
    '[data-entity-urn*="messagingThread"] a[href]',
  ],
  participantName: [
    '[data-anonymize="person-name"]',
    '.msg-conversation-listitem__participant-names',
    '[class*="participant"]',
  ],
  snippet: [
    '.msg-conversation-card__message-snippet',
    '[data-testid="conversation-snippet"]',
  ],
  timestamp: ['time[datetime]', 'time'],
  messageContainers: [
    '[aria-label*="message" i][role="list"]',
    '.msg-s-message-list-content',
    'main ul:has([data-event-urn])',
  ],
  messageRows: [
    '[data-event-urn]',
    '.msg-s-event-listitem',
    '[data-testid="message-item"]',
  ],
  messageText: [
    '.msg-s-event-listitem__body',
    '[data-testid="message-body"]',
    '[data-message-text]',
  ],
  senderLink: ['a[href*="/in/"]', '[data-sender-profile]'],
} as const;

