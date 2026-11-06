// Every Slack DOM assumption lives here.
// Verified against real samples in events/calhacks-13/fixtures/slack-dom/ (spons-moss, spons-capital-one and spons-factory-ai
// views, 2026-10-27) by parse.fixtures.test.ts, which checks parsing against the slackdump export.
// Entries marked UNVERIFIED had no matching element in the samples and are kept as best guesses.
// Each entry is a comma-separated candidate list.

export const SEL = {
  /** The element that actually scrolls the message pane. */
  scroller: '[data-qa="message_pane"] [data-qa="slack_kit_scrollbar"].c-scrollbar__hider',
  /** Container whose subtree mutations mean rows were added. */
  list: '[data-qa="message_pane"] [data-qa="slack_kit_list"]',
  /** One virtual-list row (message, system row, divider, channel intro). Scoped to the pane: the
   *  channel sidebar uses the same virtual-list classes. */
  row: '[data-qa="message_pane"] .c-virtual_list__item',
  /** Permalink anchor; its href carries the ts in p-form. Posts use a.c-timestamp (with data-ts);
   *  system rows put a plain link inside <time>. */
  timestamp: 'a.c-timestamp, time > a[href*="/archives/"]',
  /** Author header (absent on grouped posts). */
  sender: '[data-qa="message_sender_name"]',
  /** Attribute on the sender element that may hold the user ID. */
  senderIdAttr: "data-message-sender",
  /** Inline title next to the author, only if Slack renders one (D6). */
  /** UNVERIFIED: no sample poster had an inline title. */
  senderTitle: '[data-qa="message_sender_title"], .c-message__sender_title',
  /** UNVERIFIED: APP / BOT badge. Slackbot shows none; it's recognized by BOT_SENDER_IDS instead. */
  botBadge: '.c-app_badge, [data-qa="app_badge"], [data-qa="bot_badge"]',
  /** Slack Connect (external organization) marker: a team icon on the avatar, header rows only. */
  externalBadge: '.c-message_kit__gutter__left [data-qa="team-icon"]',
  /** Join / topic / rename rollups. They have no message-text body. */
  systemMessage: '.c-message__system_message',
  /** Message body (text blocks only, not attachments/reactions). */
  body: '[data-qa="message-text"]',
  /** Paragraph break inside a rich-text section; serialized as a blank line. */
  paragraphBreak: '[data-stringify-type="paragraph-break"]',
  /** Bits inside the body that aren't message text. */
  bodyNoise: '.c-message__edited_label, [data-qa="message_edited_label"]',
  /** Day dividers render as two rows: the label (keyed "<ms>.<channel>") and the line ("<ms>divider"). */
  divider: '.c-message_list__day_divider, .c-message_list__day_divider__label, .c-message_list__unread_divider',
  /** The channel intro ("This is the very beginning of …"), keyed 0000000000.000001. */
  channelStart: '.p-message_pane__foreword',
  /** Channel name in the header, for channel_name. */
  channelName: '[data-qa="channel_name"]',
} as const;

/** Sender IDs that are bots even without a badge. */
export const BOT_SENDER_IDS = new Set(["USLACKBOT"]);

/** Text fallbacks for rows SEL doesn't mark. `system` is only tried on rows without a message body. */
export const TEXT = {
  channelStart: /\bThis is the very beginning of the\b|\bthe very beginning of #/i,
  /** Join/leave/rename/topic/purpose rows (export subtypes channel_join, channel_name, channel_topic, channel_purpose),
   *  and deleted-parent tombstones (subtype tombstone). */
  system:
    /\b(?:joined|left) (?:#|the channel)|\brenamed the channel|\b(?:set|changed|cleared) the channel (?:topic|description|purpose)|\bwas added to (?:#|the channel)|^This message was deleted\.?$/i,
} as const;
