import { describe, expect, it } from "vitest";
import { gitRefResponse, parseGitUploadPackAdvertisement } from "../src/github-git";

describe("Git smart HTTP refs", () => {
  it("reconstructs exact new-style branch ref responses", () => {
    const refs = parseGitUploadPackAdvertisement(
      advertisement([
        [
          "e05a16c766609e722571a448f606f6820a0bf249",
          "HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/main",
        ],
        ["e05a16c766609e722571a448f606f6820a0bf249", "refs/heads/main"],
      ]),
    );

    expect(
      gitRefResponse(refs!, "R_kgDOSoyMqw", "openclaw", "octopool", "heads/main", false),
    ).toEqual({
      ref: "refs/heads/main",
      node_id: "REF_kwDOSoyMq69yZWZzL2hlYWRzL21haW4",
      url: "https://api.github.com/repos/openclaw/octopool/git/refs/heads/main",
      object: {
        sha: "e05a16c766609e722571a448f606f6820a0bf249",
        type: "commit",
        url: "https://api.github.com/repos/openclaw/octopool/git/commits/e05a16c766609e722571a448f606f6820a0bf249",
      },
    });
  });

  it("reconstructs old-style IDs and annotated tags", () => {
    const refs = parseGitUploadPackAdvertisement(
      advertisement([
        ["0123456789012345678901234567890123456789", "refs/tags/v1.0.0"],
        ["abcdefabcdefabcdefabcdefabcdefabcdefabcd", "refs/tags/v1.0.0^{}"],
      ]),
    );

    expect(
      gitRefResponse(refs!, "MDEwOlJlcG9zaXRvcnkyMTI2MTMwNDk=", "cli", "cli", "tags/v1.0.0", false),
    ).toMatchObject({
      ref: "refs/tags/v1.0.0",
      node_id: "MDM6UmVmMjEyNjEzMDQ5OnJlZnMvdGFncy92MS4wLjA=",
      object: {
        sha: "0123456789012345678901234567890123456789",
        type: "tag",
      },
    });
  });

  it("rejects ambiguous lightweight tags", () => {
    const refs = parseGitUploadPackAdvertisement(
      advertisement([["0123456789012345678901234567890123456789", "refs/tags/v1.0.0"]]),
    );

    expect(
      gitRefResponse(refs!, "R_kgDOSoyMqw", "openclaw", "octopool", "tags/v1.0.0", false),
    ).toBeUndefined();
  });

  it("returns complete matching branch prefixes", () => {
    const refs = parseGitUploadPackAdvertisement(
      advertisement([
        ["0123456789012345678901234567890123456789", "refs/heads/main"],
        ["abcdefabcdefabcdefabcdefabcdefabcdefabcd", "refs/heads/maint"],
      ]),
    );

    expect(
      gitRefResponse(refs!, "R_kgDOSoyMqw", "openclaw", "octopool", "heads", true),
    ).toHaveLength(2);
  });

  it("matches GitHub's long-ref node encoding", () => {
    const refs = parseGitUploadPackAdvertisement(
      advertisement([
        ["39cd70caf53f929ae8fd2f521e73252d095bc70a", "refs/heads/add-windows-acl-tests"],
      ]),
    );

    expect(
      gitRefResponse(
        refs!,
        "R_kgDOQb6kRw",
        "openclaw",
        "openclaw",
        "heads/add-windows-acl-tests",
        false,
      ),
    ).toMatchObject({
      node_id: "REF_kwDOQb6kR9oAIHJlZnMvaGVhZHMvYWRkLXdpbmRvd3MtYWNsLXRlc3Rz",
    });
  });
});

function advertisement(lines: [string, string][]): Uint8Array {
  const packets = [
    packet("# service=git-upload-pack\n"),
    "0000",
    ...lines.map(([sha, ref]) => packet(`${sha} ${ref}\n`)),
    "0000",
  ];
  return new TextEncoder().encode(packets.join(""));
}

function packet(value: string): string {
  return (new TextEncoder().encode(value).byteLength + 4).toString(16).padStart(4, "0") + value;
}
