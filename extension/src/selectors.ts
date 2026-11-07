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
  /** The area under the message list where the composer, or Slack's "who can post" notice, sits.
   *  UNVERIFIED: no DOM sample of a restricted channel yet (D19); posting_restricted is null when absent. */
  footer: '[data-qa="message_pane"] ~ footer, .p-workspace__primary_view_footer, [data-qa="message_input"]',
  composer: '[data-qa="message_input"], .ql-editor[contenteditable="true"]',

  // "Sync this event" (user 2026-11-06). Verified in the spons-moss samples: the reply bar under a parent post,
  // the sidebar's channel items, and the message container that carries the ts outside any pane-specific class.
  /** The "N replies · Last reply …" bar under a parent post. */
  replyBar: '[data-qa="reply_bar"]',
  /** The button in the reply bar that opens the thread pane; text "N replies"; aria-expanded="true" while open. */
  replyCount: '[data-qa="reply_bar_count"]',
  /** Holds the newest reply's ts in data-ts. */
  lastReply: '[data-qa="reply_bar_hover_last_reply"]',
  /** One channel in the sidebar; the id is in data-qa-channel-sidebar-channel-id. */
  sidebarChannel: '[data-qa="channel-sidebar-channel"]',
  sidebarChannelIdAttr: "data-qa-channel-sidebar-channel-id",
  /** The channel's name, as data-qa="channel_sidebar_name_<name>". */
  sidebarChannelName: '[data-qa^="channel_sidebar_name_"]',
  sidebar: '[data-qa="channel-sidebar"]',
  /** Every rendered message, in any pane; its ts is in data-msg-ts. */
  messageContainer: '[data-qa="message_container"]',
  messageTsAttr: "data-msg-ts",
  /** The primary view's message pane; the thread pane is anything outside it. */
  messagePane: '[data-qa="message_pane"]',

  // Thread pane. UNVERIFIED until the first sync saves pane samples (fixtures/slack-dom/*--thread-*.html): these
  // candidates are tried first, then the pane is found without them (thread.ts: the subtree outside the message
  // pane that renders the parent's message container).
  threadPane: '[data-qa="threads_flexpane"], .p-threads_flexpane, [data-qa="thread_view"], [data-qa="secondary_view"]',
  threadClose: '[data-qa="close_flexpane"], [data-qa="flexpane_close_button"], button[aria-label="Close"], button[aria-label="Close thread"]',
} as const;

/** Sender IDs that are bots even without a badge. */
export const BOT_SENDER_IDS = new Set(["USLACKBOT"]);

/** Text fallbacks for rows SEL doesn't mark. `system` is only tried on rows without a message body. */
export const TEXT = {
  /** The reply bar's button text, when data-qa is missing (D5 fallback). */
  replyCount: /^(\d+)\s+repl(?:y|ies)$/i,
  /** UNVERIFIED: a control in the thread pane that loads replies it isn't showing yet. */
  moreReplies: /^(?:show|load|view|see)\s+(?:\d+\s+)?(?:more|older|earlier|newer|other|previous)\s+repl(?:y|ies)\b|^\d+\s+more\s+repl(?:y|ies)\b/i,
  /** UNVERIFIED: the label on a reply that was also sent to the channel. */
  alsoSent: /\balso sent to (?:the channel|#)/i,
  channelStart: /\bThis is the very beginning of the\b|\bthe very beginning of #/i,
  /** Join/leave/rename/topic/purpose rows (export subtypes channel_join, channel_name, channel_topic, channel_purpose),
   *  and deleted-parent tombstones (subtype tombstone). */
  /** Slack's notice in place of the composer in a channel only some members can post in. UNVERIFIED wording. */
  postingRestricted: /\bonly (?:certain|specific|some|select(?:ed)?) (?:people|members)\b[^.]*\bpost\b|\bposting (?:in this channel )?(?:is|has been) (?:restricted|limited)\b|\bonly (?:workspace )?(?:admins|owners)\b[^.]*\bpost\b/i,
  system:
    /\b(?:joined|left) (?:#|the channel)|\brenamed the channel|\b(?:set|changed|cleared) the channel (?:topic|description|purpose)|\bwas added to (?:#|the channel)|^This message was deleted\.?$/i,
} as const;
