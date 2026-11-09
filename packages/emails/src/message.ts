/** An email ready to send: the subject, the plain-text alternative and the HTML version. */
export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}
