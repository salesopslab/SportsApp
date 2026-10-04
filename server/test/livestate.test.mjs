// Live clock / quarter / inning from ESPN's scoreboard, matched to the odds
// feed's team names. Event shapes copied from real ESPN responses (Oct 3 2026).
import assert from "node:assert/strict";
const { parseEspnScoreboard, lookupLiveState, buildEspnLiveEntry, liveNameKey } = await import("../src/services/statsService.js");
const t = (name, fn) => { fn(); console.log("PASS ", name); };

const ev = (state, { name = "STATUS_IN_PROGRESS", period, clock, short, situation = {}, home, away }) => ({
  competitions: [{
    status: { period, displayClock: clock, type: { state, name, shortDetail: short, detail: short } },
    situation,
    competitors: [
      { homeAway: "home", team: home },
      { homeAway: "away", team: away },
    ],
  }],
});
const team = (displayName, location, name) => ({ displayName, location, name });

t("college football: clock + quarter + down & distance, halftime, end of quarter", () => {
  const json = { events: [
    ev("in", { period: 3, clock: "1:27", short: "1:27 - 3rd", situation: { downDistanceText: "4th & 10 at FAU 23" }, home: team("Florida Atlantic Owls", "Florida Atlantic", "Owls"), away: team("Texas Southern Tigers", "Texas Southern", "Tigers") }),
    ev("in", { name: "STATUS_HALFTIME", period: 2, clock: "0:00", short: "Halftime", home: team("TCU Horned Frogs", "TCU", "Horned Frogs"), away: team("BYU Cougars", "BYU", "Cougars") }),
    ev("in", { period: 4, clock: "0:00", short: "End of 4th", home: team("Colorado State Rams", "Colorado State", "Rams"), away: team("Oregon State Beavers", "Oregon State", "Beavers") }),
    ev("in", { period: 5, clock: "0:00", short: "OT", home: team("San José State Spartans", "San José State", "Spartans"), away: team("Hawai'i Rainbow Warriors", "Hawai'i", "Rainbow Warriors") }),
    ev("in", { period: 2, clock: "8:04", short: "8:04 - 2nd", home: team("UConn Huskies", "UConn", "Huskies"), away: team("Texas A&M Aggies", "Texas A&M", "Aggies") }),
    ev("post", { period: 4, clock: "0:00", short: "Final", home: team("Rice Owls", "Rice", "Owls"), away: team("UTSA Roadrunners", "UTSA", "Roadrunners") }),
  ] };
  const map = parseEspnScoreboard("ncaaf", json);
  assert.deepEqual(lookupLiveState("ncaaf", map, "Florida Atlantic Owls", "Texas Southern Tigers"), { line: "Q3 1:27", detail: "4th & 10 at FAU 23", source: "ESPN" });
  assert.equal(lookupLiveState("ncaaf", map, "TCU Horned Frogs", "BYU Cougars").line, "Halftime");
  assert.equal(lookupLiveState("ncaaf", map, "Colorado State Rams", "Oregon State Beavers").line, "End of 4th");
  // Accents / apostrophes differ between feeds.
  assert.equal(lookupLiveState("ncaaf", map, "San Jose State Spartans", "Hawaii Rainbow Warriors").line, "OT");
  // Same mascot, school name written differently.
  assert.equal(lookupLiveState("ncaaf", map, "Connecticut Huskies", "Texas A&M Aggies").line, "Q2 8:04");
  // Finished games aren't live; unknown games never get a made-up state.
  assert.equal(lookupLiveState("ncaaf", map, "Rice Owls", "UTSA Roadrunners"), null);
  assert.equal(lookupLiveState("ncaaf", map, "Florida Atlantic Owls", "Rice Owls"), null);
});

t("NFL / NBA / college hoops period labels", () => {
  const nfl = parseEspnScoreboard("nfl", { events: [ev("in", { period: 2, clock: "3:12", short: "3:12 - 2nd", situation: { downDistanceText: "3rd & 7 at KC 25" }, home: team("Kansas City Chiefs", "Kansas City", "Chiefs"), away: team("Denver Broncos", "Denver", "Broncos") })] });
  assert.deepEqual(lookupLiveState("nfl", nfl, "Kansas City Chiefs", "Denver Broncos"), { line: "Q2 3:12", detail: "3rd & 7 at KC 25", source: "ESPN" });
  const nba = parseEspnScoreboard("nba", { events: [ev("in", { period: 4, clock: "2:41", short: "2:41 - 4th", home: team("Los Angeles Lakers", "Los Angeles", "Lakers"), away: team("LA Clippers", "LA", "Clippers") })] });
  assert.deepEqual(lookupLiveState("nba", nba, "Los Angeles Lakers", "Los Angeles Clippers"), { line: "Q4 2:41", detail: null, source: "ESPN" });
  const cbb = buildEspnLiveEntry("ncaab", ev("in", { period: 2, clock: "11:09", short: "11:09 - 2nd Half", home: team("Duke Blue Devils", "Duke", "Blue Devils"), away: team("Kentucky Wildcats", "Kentucky", "Wildcats") }));
  assert.equal(cbb.line, "H2 11:09");
  assert.equal(buildEspnLiveEntry("nfl", ev("in", { period: 5, clock: "6:30", short: "6:30 - OT", home: {}, away: {} })).line, "OT 6:30");
});

t("MLB: inning, outs and count", () => {
  const mlb = parseEspnScoreboard("mlb", { events: [ev("in", { period: 5, short: "Top 5th", situation: { outs: 1, balls: 2, strikes: 1 }, home: team("Tampa Bay Rays", "Tampa Bay", "Rays"), away: team("New York Yankees", "New York", "Yankees") })] });
  assert.deepEqual(lookupLiveState("mlb", mlb, "Tampa Bay Rays", "New York Yankees"), { line: "Top 5th", detail: "1 out • 2-1 count", source: "ESPN" });
});

t("name keys ignore accents, apostrophes and &", () => {
  assert.equal(liveNameKey("San José State"), liveNameKey("San Jose State"));
  assert.equal(liveNameKey("Hawai'i Rainbow Warriors"), "hawaii rainbow warriors");
  assert.equal(liveNameKey("Texas A&M Aggies"), "texas a and m aggies");
});
console.log("All live-state tests passed");
