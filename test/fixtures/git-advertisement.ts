// Synthetic wire fixtures: an encoder, never an independent parser/oracle.
export const gitSHA = "0123456789012345678901234567890123456789";
export const gitOtherSHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
export const gitService = "001e# service=git-upload-pack\n0000";
export const gitMain = `003d${gitSHA} refs/heads/main\n`;
export const gitMaint = `003e${gitOtherSHA} refs/heads/maint\n`;
export const completeGitAdvertisement = gitService + gitMain + gitMaint + "0000";
export const gitAdvertisementURL =
  "https://github.com/openclaw/octopool.git/info/refs?service=git-upload-pack";
export const gitNodeURL = "https://github.com/openclaw/octopool/issues?q=is%3Aissue";
export const gitMIME = "application/x-git-upload-pack-advertisement";
export const gitNodeHTML =
  '<script type="application/json" data-target="react-app.embeddedData">{"payload":{"preloadedQueries":[{"queryName":"IssueIndexPageQuery","result":{"data":{"repository":{"id":"R_kgDOSoyMqw"}}}}]}}</script>';
export const exactGitRefs = [
  { ref: "refs/heads/main", node_id: "REF_exact_main", object: { sha: gitSHA, type: "commit" } },
  {
    ref: "refs/heads/maint",
    node_id: "REF_exact_sentinel",
    object: { sha: gitOtherSHA, type: "commit" },
    exact_field: "retained",
  },
];

export function gitPacket(payload: string): string {
  return (new TextEncoder().encode(payload).byteLength + 4).toString(16).padStart(4, "0") + payload;
}

export const malformedGitAdvertisements = [
  ["packet-boundary EOF", gitService + gitMain],
  ["missing terminal flush", completeGitAdvertisement.slice(0, -4)],
  ["partial prefix", gitService + gitMain + "003"],
  ["partial payload", gitService + gitMain + gitMaint.slice(0, -2)],
  ["header flush only", gitService],
  ["missing service", gitMain + "0000"],
  ["wrong service", gitPacket("# service=git-receive-pack\n") + "0000" + gitMain + "0000"],
  ["missing header flush", gitService.slice(0, -4) + gitMain + "0000"],
  ["reserved delimiter", gitService + gitMain + "0001" + gitMaint + "0000"],
  ["reserved response end", gitService + gitMain + "0002" + gitMaint + "0000"],
  ["reserved length three", gitService + gitMain + "0003" + "0000"],
  ["empty data record", gitService + gitMain + "0004" + "0000"],
  ["empty data instead of completion", gitService + gitMain + "0004"],
  ["trailing garbage", completeGitAdvertisement + "garbage"],
  ["extra flush", completeGitAdvertisement + "0000"],
  ["appended refs", completeGitAdvertisement + gitPacket(`${gitSHA} refs/heads/extra\n`) + "0000"],
  ["repeated service", gitService + gitMain + gitService + "0000"],
  ["version two", gitService + gitPacket("version 2\n") + gitMain + "0000"],
  ["shallow metadata", gitService + gitMain + gitPacket(`shallow ${gitSHA}\n`) + "0000"],
  [
    "late capabilities",
    gitService + gitMain + gitPacket(`${gitOtherSHA} refs/heads/maint\0multi_ack\n`) + "0000",
  ],
  [
    "BOM before service",
    gitPacket("\ufeff# service=git-upload-pack\n") + "0000" + gitMain + "0000",
  ],
  ["extra ref LF", gitService + gitPacket(`${gitSHA} refs/heads/main\n\n`) + "0000"],
] as const;
