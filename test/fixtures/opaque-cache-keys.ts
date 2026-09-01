// Frozen by the actual key owner at 211e9cf, before the opaque codec generation.
// Literal digests keep retirement tests independent of the current key implementation.
export const opaqueCacheKeys = [
  {
    name: "raw blob",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/blobs/abc1234",
      headers: {
        accept: "application/vnd.github.raw",
      },
    },
    shared: "clSNYK013hjfEoxuK0FKHzaAIV_Fqo36yohKnGqtjIo",
    identity: "q2dYHqrm3LPiWNOPYPmVZFxhyUoBCyepAjbFJ1ewUo0",
  },
  {
    name: "raw contents",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      headers: {
        accept: "application/vnd.github.raw",
      },
    },
    shared: "1BGppmAK_r7_g5lqvUeYGlGMgJx5I9NsgcNxiGpr0w0",
    identity: "uCozzBVYFheVP4M-P8QVdioKayolqrxD0rwx_MQOrCc",
  },
  {
    name: "raw readme",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/readme",
      headers: {
        accept: "application/vnd.github.raw",
      },
    },
    shared: "HZdS9GXnXM17ir2gMrLyqr_blfqdLHkSpS5gO_WITG4",
    identity: "u8mkb4YEwwJduqR-Av0ERSniBdtSKbhJNpogzBbpeVY",
  },
  {
    name: "octet stream",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      headers: {
        accept: "application/octet-stream",
      },
    },
    shared: "sZpHU8dw9j2eO3KC3oVdXeStiXoAf0a26-tkD57CplY",
    identity: "EQ8Xmp01jO4x_7aBfgZJcluR5rDefdm014BHBCpRNj8",
  },
  {
    name: "diff",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: {
        accept: "application/vnd.github.diff",
      },
    },
    shared: "jdpcKO0AmDFCd3Ekk4S6mnVvmBtEUqvSbMC9VzkGn1A",
    identity: "_EGSoukEpWXms6xWe1jGj2iW2xo3KMubmlHoGjwXMFM",
  },
  {
    name: "patch",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: {
        accept: "application/vnd.github.patch",
      },
    },
    shared: "BR7lrxtUFOf1mC1nAhxxe-y5-rr8fJUYGOoN6tpMakk",
    identity: "uQZlo-XhoLlJIRLb44BxE-PiMLc-qfd4stoa6v1SmaM",
  },
  {
    name: "custom JSON",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/issues/12",
      headers: {
        accept: "application/vnd.github.full+json",
      },
    },
    shared: "_GELCI0ATgduVLonkpC8eZUramcc3YUeF_U9ADKe4JY",
    identity: "mnTnrWmE3q7DzEj8geK58RQ4jiDv-PIX_vg-BHwKU5s",
  },
  {
    name: "blank accept",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/issues/12",
      headers: {
        accept: "",
      },
    },
    shared: "5JjfgBfRWhDPE1THcScXebogQwsachSzlURBTECkLb4",
    identity: "mBC_GCIrKXYCi0N6A0yQLnRZ00Io_-zuItZWjBreADo",
  },
  {
    name: "Actions custom",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/99",
      headers: {
        accept: "application/vnd.github.raw",
        "x-octopool-public-shape": "actions-summary-v1",
      },
    },
    shared: "8ysdcZJBBWNCb5VHeS02HEK6UgrUfZ3ALzpSkCM6J1I",
    identity: "Qs21EFbMufsOdoC53IDc4salAFTzjlskZeanupm92VE",
  },
  {
    name: "release custom",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases/latest",
      headers: {
        accept: "application/vnd.github.raw",
        "x-octopool-public-shape": "release-summary-v1",
      },
    },
    shared: "80ZA_xxUU6DfeJaMH-mCko1gnxh_bHhs1fefpCdRacA",
    identity: "oyy9LLe4_iQuFJhRa_FqHR59jLG5-WsgTDcXmnP6rPk",
  },
  {
    name: "event custom",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/issues/12/events",
      headers: {
        accept: "application/vnd.github.raw",
      },
    },
    shared: "ehL_CtVISDu7s5mxEzH2O5IIjtGmhWOqcPDUxILgUEA",
    identity: "68xOYDlSn0KHCtf2anrG4Qg4IidpzjbaYMgS5-l4xSg",
  },
] as const;
export const unchangedJSONKeys = [
  {
    name: "default JSON",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/blobs/abc1234",
      headers: {},
    },
    shared: "YrggK6f6E9YQzLvANPrlswuTc4cJDMnCGSdEr0PVPu4",
    identity: "vJlhZLlac044XT-77kbtsnX8enod95t02_5QJwxWC_Q",
  },
  {
    name: "Actions JSON",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/99",
      headers: {
        "x-octopool-public-shape": "actions-summary-v1",
      },
    },
    shared: "0pVeb2WHHYXmtnvahq4bJ3cIAw7Z2Tl9je-0PQNpyOg",
    identity: "yhytp06UBbXYjiz73t8bpOppnExFMXLQiWXLOGfYUOE",
  },
  {
    name: "release JSON",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases/latest",
      headers: {
        "x-octopool-public-shape": "release-summary-v1",
      },
    },
    shared: "IW8GTqJYZGRDRACPwieFPOWWrbRvgv3Jnvdj8aQUQVw",
    identity: "RVPH6W_dfj72c6pREDmVo98G-j7bI6Dsh4YI1nYWY8o",
  },
  {
    name: "event JSON",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/issues/12/events",
      headers: {},
    },
    shared: "_NFlXimWhvHiNn8Q63JPRM3ObCweHjY3CW2WaaKE550",
    identity: "_57Yhxfd5F1OP5rY4bKQjgDkprBYdoZqi3HUjUAL8EY",
  },
  {
    name: "attempt jobs",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/99/attempts/2/jobs",
      headers: {
        "x-octopool-public-shape": "actions-jobs-v1",
      },
    },
    shared: "jiJ5V_ttqoefYTJdIUFMq15e-q9nVKzWS5S21hDz5_8",
    identity: "pIKjI16NpLq1Ie4H5Pic8bdLks9cyGmzTCyX1T-KQYo",
  },
] as const;
