// Every Slack DOM assumption lives here.
// UNVERIFIED: drafted from Slack web-client conventions before any sample of the real DOM was
// available. fixtures/slack-dom/ was empty when this was written. Confirm or replace each entry
// against the saved samples; parse.fixtures.test.ts checks the result against the export.
// Each entry is a comma-separated candidate list; the first match wins.

export const SEL = {
  /** The element that actually scrolls the message pane. */
  scroller: '[data-qa="message_pane"] .c-scrollbar__hider, .p-message_pane .c-scrollbar__hider',
  /** Container whose subtree mutations mean rows were added. */
  list: '[data-qa="message_pane"] [role="list"], .p-message_pane .c-virtual_list__scroll_container',
  /** One virtual-list row (message, system row, divider, channel intro). */
  row: '.c-virtual_list__item, [data-qa="virtual-list-item"]',
  /** Permalink anchor; its href carries the ts in p-form. */
  timestamp: 'a.c-timestamp, a[data-qa="timestamp_label"]',
  /** Author header (absent on grouped posts). */
  sender: '[data-qa="message_sender_name"], .c-message__sender_button',
  /** Attribute on the sender element that may hold the user ID. */
  senderIdAttr: "data-message-sender",
  /** Inline title next to the author, only if Slack renders one (D6). */
  senderTitle: '[data-qa="message_sender_title"], .c-message__sender_title',
  /** APP / BOT badge next to the sender. */
  botBadge: '.c-app_badge, [data-qa="app_badge"], [data-qa="bot_badge"]',
  /** Slack Connect / external organization marker next to the sender. */
  externalBadge: '[data-qa="external_org_icon"], .c-message__sender .c-shared_channel_icon, [data-qa="shared_channel_badge"]',
  /** Message body (text blocks only, not attachments/reactions). */
  body: '[data-qa="message-text"], .c-message_kit__blocks, .c-message__body',
  /** Bits inside the body that aren't message text. */
  bodyNoise: '.c-message__edited_label, [data-qa="message_edited_label"]',
  divider: '.c-message_list__day_divider, .c-message_list__unread_divider, [data-qa="day_divider"]',
  channelStart: '[data-qa="channel_intro"], .p-message_pane_foreword, .p-channel_intro',
  /** Channel name in the header, for channel_name. */
  channelName: '[data-qa="channel_name"], .p-view_header__channel_title',
} as const;

/** Text fallbacks for things classes may not mark. Matched against a row's whole text. */
export const TEXT = {
  channelStart: /\bThis is the very beginning of the\b|\bthe very beginning of #/i,
  /** Join/leave/rename/topic/purpose rows (export subtypes channel_join, channel_name, channel_topic, channel_purpose),
   *  and deleted-parent tombstones (subtype tombstone). */
  system:
    /^(?:has |)joined (?:#|the channel)|^(?:has |)left (?:#|the channel)|^renamed the channel|^set the channel (?:topic|description|purpose)|^(?:changed|cleared) the channel (?:topic|description|purpose)|^was added to (?:#|the channel)|^This message was deleted\.?$/i,
} as const;
