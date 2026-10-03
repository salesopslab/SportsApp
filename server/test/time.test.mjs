// Per-user time zones: labels, local dates, and AI tool-result tagging.
import assert from "node:assert/strict";
import { validTz, localLabel, localDay, addLocalTimes, userTimeLine, DEFAULT_TZ, currentTz } from "../src/services/timeService.js";

const t = (name, fn) => { fn(); console.log("PASS ", name); };
const kick = "2026-10-03T02:15:00Z"; // Fri 7:15 PM PDT / 10:15 PM EDT

t("valid IANA zones accepted, junk rejected", () => {
  assert.equal(validTz("America/Los_Angeles"), "America/Los_Angeles");
  assert.equal(validTz("Europe/London"), "Europe/London");
  assert.equal(validTz("Mars/Olympus"), null);
  assert.equal(validTz(""), null);
  assert.equal(validTz("x".repeat(100)), null);
});
t("labels follow the user's zone", () => {
  assert.equal(localLabel(kick, "America/Los_Angeles"), "Fri, Oct 2, 7:15 PM PDT");
  assert.equal(localLabel(kick, "America/New_York"), "Fri, Oct 2, 10:15 PM EDT");
  assert.equal(localLabel(kick, "America/Chicago"), "Fri, Oct 2, 9:15 PM CDT");
});
t("local date flips at the user's midnight, not UTC's", () => {
  assert.equal(localDay(kick, "America/Los_Angeles"), "2026-10-02");
  assert.equal(localDay(kick, "Europe/London"), "2026-10-03");
});
t("tool results get *_local labels", () => {
  const out = addLocalTimes({ games: [{ start_utc: kick }], upcoming: { kickoff: kick }, note: "2026-10-03T02:15:00Z" }, "America/Denver");
  assert.equal(out.games[0].start_local, "Fri, Oct 2, 8:15 PM MDT");
  assert.equal(out.upcoming.kickoff_local, "Fri, Oct 2, 8:15 PM MDT");
  assert.equal(out.note_local, undefined); // only known time fields
});
t("default outside a request is US Eastern", () => {
  assert.equal(currentTz(), DEFAULT_TZ);
  assert.match(userTimeLine(kick, "America/Los_Angeles"), /7:15 PM PDT.*America\/Los_Angeles.*PDT/);
});
console.log("All time zone tests passed");
