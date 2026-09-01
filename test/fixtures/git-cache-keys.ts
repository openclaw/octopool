// Frozen by the actual key owner at b08d2e2, before Git framing retirement.
// Both digests include publication-v1; nondefault media retain lossless-v1.
export const gitCacheKeys = [
  {
    name: "matching heads",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/matching-refs/heads/ma",
    },
    shared: "Cmg-d1lu22tQ3qpsNopxN5RNZLubvOc8xMRT8dM9oDA",
    identity: "zSgZULDWBYZtGywl0DUK0gA9PvcAljWexEhH0H0RP1w",
  },
  {
    name: "exact head",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/ref/heads/main",
    },
    shared: "s6-vo9j43IkKL76W0GvOLenj999a0JPrxfSbkEK78OU",
    identity: "-sCnW3xNxKI9TWJrBee_FHsSV4L1_3xs8d1pIKYNg4o",
  },
  {
    name: "matching tags",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/matching-refs/tags/v1",
    },
    shared: "P4Ns2LJKo-8L02Kbepmc6143ARuzUnriouKgtTyE4n0",
    identity: "DWXq43xqwxCgfY1Q2SmTVI8dELOjLg2nS1XRpJm_02M",
  },
  {
    name: "exact tag",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/ref/tags/v1.0.0",
    },
    shared: "oxZEJ9KBSN8IP4-LZkyoHiKC1sMGjdM5Hh0Cp5oE97Y",
    identity: "KjiX9Rf0FIahQ6r7z34EWKIRgHgjiODoNO9fumth4Qc",
  },
  {
    name: "branch list",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/branches",
    },
    shared: "hVOuiU8QbfmD8C29bNr4PiRsx5evsFW7bxIzVN_b9mE",
    identity: "N0-Tv00LvleuYKJDZlcvOxYTXPsmvutG8kO7GuKYiXo",
  },
  {
    name: "branch view",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/branches/main",
    },
    shared: "7UKpTu2GuXLIja70TQ3x2cUQu3-pYjS0uB_61SD6MEo",
    identity: "o5RByGGZaFu3n461Qit-2Vj5rpo26Qml_Ul3vcRZDTk",
  },
  {
    name: "Git commit",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/commits/abc1234",
    },
    shared: "cmBa4nXsf3sQE1MpbhSoyik-NACTbBUObHFByqvVQXU",
    identity: "HoZU48Ub7f7ZXdJm165j9UDRg0a82p9jiqTp4JIpzEg",
  },
  {
    name: "Git tree",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/trees/abc1234",
    },
    shared: "SOVTx6oLrQeZ6fvFeZts3dKVErHSM9ZQwxbFv9104sQ",
    identity: "kk4O2RDZ65srlzRLA8VFwzhunzEHpWO0ZAkFk3a-hQk",
  },
  {
    name: "Git tag object",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/tags/abc1234",
    },
    shared: "yZ-mDiXrWQ_5no2MQnwDOcG10CrLguNgNlvlcaIF_To",
    identity: "h1BcHTiIGWcTZydSQPuH77DptDfQBm6X2I9asEK6gLk",
  },
  {
    name: "Git blob",
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
    name: "raw ref",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/ref/heads/main",
      headers: {
        accept: "application/vnd.github.raw",
      },
    },
    shared: "QCcQRBkoTl8qJzIC14LTptFyIbiq-NrDSNLJ0CqDUYI",
    identity: "-R-bLiY5JW6rVpLFt_6mdum4wyWmgYDa0v2Ln9zTw4I",
  },
  {
    name: "custom matching",
    retire: false,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/matching-refs/heads/ma",
      headers: {
        accept: "application/octet-stream",
      },
    },
    shared: "ZJ34SiapMNbHPurj4HFjfEg-vTXQJH7l62JV7cmGW_U",
    identity: "CeYKGGknUxvqhF5dV4SUVx2mfPj609GMLh6BrR1OoW4",
  },
  {
    name: "blank accept ref",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/ref/heads/main",
      headers: {
        accept: "",
      },
    },
    shared: "iiIh8OnaMj-wnV2WUamaR89WkGwXiN-bICvAfrMwSfU",
    identity: "jDH0RtUh9Ge2qemZJfEWaKsXgPUpfLAb_h0X6k-iOvs",
  },
  {
    name: "blank matching heads",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/matching-refs/heads/ma",
      headers: {
        accept: "",
      },
    },
    shared: "ytGo82Bt0YyAsHoi7fXAQzWsm_6GzYjDgeSUiGcRW24",
    identity: "AfDC6_qHlralcaWjbZ_pqgUvc4NlVvOK6c2NNGU5zpM",
  },
  {
    name: "whitespace matching heads",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/matching-refs/heads/ma",
      headers: {
        accept: " \t ",
      },
    },
    shared: "uJ30S5-aEWr1NpPEksu5lkNjwpcNr80UtgAI8IdQbqY",
    identity: "jJ4wcNte5JgOJfQIqi5N68pTmaP2wTIMzR8-a3sniOU",
  },
  {
    name: "whitespace exact head",
    retire: true,
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/ref/heads/main",
      headers: {
        accept: " \t ",
      },
    },
    shared: "H7bMgbGMsRdYB5qNS6vxQUlBCaZ1Svxz2dp00LtjFDM",
    identity: "phWcmm6g3o1N2-Ga7E0dzmdC8oMbZHNdwrrHyzIdYK8",
  },
] as const;
