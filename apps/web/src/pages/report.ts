import "../main.css";
import { reportSender, setupReport } from "../report/report.ts";

setupReport(document, {
  send: reportSender((input, init) => fetch(input, init)),
  location: window.location,
});
