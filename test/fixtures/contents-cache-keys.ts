// Frozen by the actual key owner at fec6a1d, before contents self-link retirement.
// Shared and identity digests include publication-v1 and the current opaque body codec.
export const contentsCacheKeys = [
  {
    name: "nested links",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/docs/a%23b%3Fc%25%20name%F0%9F%A6%9E.txt",
      query: {
        ref: "feature/topic&mode=fast#part",
      },
    },
    shared: "xWPXCPHS2DQwL9SjnCSAx2vZdmlZuIKFk5HJwNMBJtY",
    identity: "6pNL_mxgILprOKRrCzRC6DwmxyEYivjwC5heW_B24eM",
  },
  {
    name: "plain filename",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: {
        ref: "main",
      },
    },
    shared: "OGyiz-X838qe7z1K7E50eWjFIE5jSA0qVoZF0mde1bQ",
    identity: "PLfE0_agw0XmiZ99k-ci3EgMn3W_J_FQzncEQ9MBfls",
  },
  {
    name: "literal percent escape",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/literal%2523.txt",
      query: {
        ref: "main",
      },
    },
    shared: "QwKu0VK30L55LaLgbDKmcKPLvHX38EHx5TVq1MCxTk0",
    identity: "Qmhdcfatl1FDwiPexCoBptSpuMeL1fvAkdUPyyb16Js",
  },
  {
    name: "scalar fallback ref",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: {
        ref: "../main",
      },
    },
    shared: "PcYREN8DtYfqTFaEduIiWwCbxlddFvnyncMvApxYvN8",
    identity: "JD-K0tmNvXNRktEcXd65Uusu54GjOfCSnhmm6VpAPlY",
  },
  {
    name: "no ref contents",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
    },
    shared: "_xlm8E-Vj4z9StmRNxeeiRxIxnDD3EzW0eh-Tc_1lro",
    identity: "Cf9Whf81Lh9BFC5TGzJ-XYxsNzx2cdtOXPDI_GU_VEU",
  },
  {
    name: "empty ref contents",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: {
        ref: "",
      },
    },
    shared: "C40xUBySIesgJwCQC-cEUgye4RDJQaOwSZ8Zfi8nqUs",
    identity: "a0QxEpfCT8f_Zi_bU6qhN3idnb5TLxpr21ESxzhf4dA",
  },
  {
    name: "array ref contents",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: {
        ref: ["main", "topic"],
      },
    },
    shared: "SPbfmfs61zY1jHVE3b0xqVTVOfCG4v9tH2BXJCyV1ac",
    identity: "R_dNBnZ_SzX8fACIjvAR3Wk4uUEoELTljKOLUMNtSZw",
  },
  {
    name: "raw contents",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: {
        ref: "main",
      },
      headers: {
        accept: "application/vnd.github.raw",
      },
    },
    shared: "78KL_YT9x-hKUcRB1UnZEDft1Qx6iaW79kBTYZInVuM",
    identity: "h8Mb_D_8werXmv_zKPjrLxhF7S6bGX5XnZQ9g1LPi8I",
  },
  {
    name: "blank accept contents",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: {
        ref: "main",
      },
      headers: {
        accept: "",
      },
    },
    shared: "f1jpVswl4dKikLpzBBitTr7uiiJ-Szh2PN4_0PEbOQ4",
    identity: "-a8a1g5Coj7V5iMuu5a1W_mKmLbCRrSC2QcafFJe3gQ",
  },
  {
    name: "octet contents",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: {
        ref: "main",
      },
      headers: {
        accept: "application/octet-stream",
      },
    },
    shared: "h5xzy2AW5MbVAhsgye6CMHWzwkm9bFA54SZhyzfiaX8",
    identity: "l0PLyL20zR0g5bMoPn6csOl1OxRfbbaH7j9Xz-7x-6Y",
  },
  {
    name: "raw blob",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/blobs/abc1234",
      headers: {
        accept: "application/vnd.github.raw",
      },
    },
    shared: "KaLB42UNhbUApjepGQI7KTNdybeZDAuWql4aQZ3F-i4",
    identity: "9Vk4rMvihoZr3wAzI8KgAk3rAU-S-LBdaLq8I0HBDK4",
  },
  {
    name: "JSON blob",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/blobs/abc1234",
    },
    shared: "YrggK6f6E9YQzLvANPrlswuTc4cJDMnCGSdEr0PVPu4",
    identity: "vJlhZLlac044XT-77kbtsnX8enod95t02_5QJwxWC_Q",
  },
  {
    name: "raw README",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/readme",
      query: {
        ref: "main",
      },
      headers: {
        accept: "application/vnd.github.raw",
      },
    },
    shared: "_UVgCzi6o2HpNZOIm8rcxgZRSAxe_JUSmQZ-LZTnMxc",
    identity: "hihbNxBtLo7AxzMUIVtqYhZFxwuMIi9c4raI0SSO0Ls",
  },
  {
    name: "JSON README",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/readme",
      query: {
        ref: "main",
      },
    },
    shared: "vZfey4xc9i7gSHZ0Dph9aqyoXDnwy72pvuKEc2c7yrk",
    identity: "9rDxOo1Enhxnftd1PrGNFTRr_0ceNKLf-gp24KIRM2c",
  },
  {
    name: "Actions",
    retire: false,
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
    name: "release",
    retire: false,
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
    name: "events",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/issues/12/events",
    },
    shared: "_NFlXimWhvHiNn8Q63JPRM3ObCweHjY3CW2WaaKE550",
    identity: "_57Yhxfd5F1OP5rY4bKQjgDkprBYdoZqi3HUjUAL8EY",
  },
  {
    name: "diff",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: {
        accept: "application/vnd.github.diff",
      },
    },
    shared: "zMFcT0oAupjrxbyrsp_CLTOK48QTtmMSq1DdQp41Ml0",
    identity: "DHOyLYkFddGF_akosOvg154AIXNvf6RSf3rwSi8nuvw",
  },
] as const;
