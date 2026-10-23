// Help Center title and description, kept apart from shared/helpContent.mjs so the route table (loaded on every
// app page) does not pull in every help article. Pure module.

export const HELP_PATH = "/faq";

export const HELP_TITLE = "Help Center";

export const HELP_DESCRIPTION =
  "Answers about MemeWarzone: wallets, launching a coin, trading, graduation, battles, leagues, rewards, fees, imports, recruiters and safety.";

/** Generic head for /faq/<slug>; the renderer and the page replace it with the topic's or article's own. */
export const HELP_ITEM_DESCRIPTION =
  "An answer from the MemeWarzone Help Center about launching, trading, graduation, battles, leagues, rewards, fees, wallets or safety.";
