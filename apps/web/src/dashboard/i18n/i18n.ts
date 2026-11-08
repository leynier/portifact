// The dashboard's i18n layer: Lingui with runtime-compiled ICU catalogs. English is the only
// locale today; adding one means adding a catalog with the same keys.
import { type I18n, setupI18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { en, type MessageId } from "./en.ts";

declare module "@lingui/core" {
  interface Register {
    messageIds: MessageId;
  }
}

export function createI18n(): I18n {
  const i18n = setupI18n();
  i18n.setMessagesCompiler(compileMessage);
  i18n.loadAndActivate({ locale: "en", messages: en });
  return i18n;
}
