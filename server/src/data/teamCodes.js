export const NFL_TEAM_CODES = {
  "Buffalo Bills": "BUF",
  "Kansas City Chiefs": "KC",
  "Green Bay Packers": "GB",
  "Detroit Lions": "DET",
  "Los Angeles Rams": "LAR",
  "Los Angeles Chargers": "LAC",
  "New England Patriots": "NE",
  "Seattle Seahawks": "SEA",
  "Carolina Panthers": "CAR",
};

export function toTeamCode(sportSlug, fullName) {
  if (sportSlug === "nfl") return NFL_TEAM_CODES[fullName] || fullName;
  return fullName;
}
