// Literal expectations for synthetic bytes 00 ff 41; no production encoder or predicate oracle.
export const contentsLinks = [
  {
    label: "hash",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/hash%23.txt",
      query: {
        ref: "main",
      },
    },
    body: {
      type: "file",
      encoding: "base64",
      name: "hash#.txt",
      path: "hash#.txt",
      sha: "a41c182af24c4b6d785ce3df3490d5f894b23e08",
      size: 3,
      content: "AP9B",
      url: "https://api.github.com/repos/openclaw/octopool/contents/hash%23.txt?ref=main",
      html_url: "https://github.com/openclaw/octopool/blob/main/hash%23.txt",
      git_url:
        "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
      download_url: "https://raw.githubusercontent.com/openclaw/octopool/main/hash%23.txt",
      _links: {
        self: "https://api.github.com/repos/openclaw/octopool/contents/hash%23.txt?ref=main",
        git: "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
        html: "https://github.com/openclaw/octopool/blob/main/hash%23.txt",
      },
    },
  },
  {
    label: "question",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/question%3F.txt",
      query: {
        ref: "main",
      },
    },
    body: {
      type: "file",
      encoding: "base64",
      name: "question?.txt",
      path: "question?.txt",
      sha: "a41c182af24c4b6d785ce3df3490d5f894b23e08",
      size: 3,
      content: "AP9B",
      url: "https://api.github.com/repos/openclaw/octopool/contents/question%3F.txt?ref=main",
      html_url: "https://github.com/openclaw/octopool/blob/main/question%3F.txt",
      git_url:
        "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
      download_url: "https://raw.githubusercontent.com/openclaw/octopool/main/question%3F.txt",
      _links: {
        self: "https://api.github.com/repos/openclaw/octopool/contents/question%3F.txt?ref=main",
        git: "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
        html: "https://github.com/openclaw/octopool/blob/main/question%3F.txt",
      },
    },
  },
  {
    label: "percent",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/percent%25.txt",
      query: {
        ref: "main",
      },
    },
    body: {
      type: "file",
      encoding: "base64",
      name: "percent%.txt",
      path: "percent%.txt",
      sha: "a41c182af24c4b6d785ce3df3490d5f894b23e08",
      size: 3,
      content: "AP9B",
      url: "https://api.github.com/repos/openclaw/octopool/contents/percent%25.txt?ref=main",
      html_url: "https://github.com/openclaw/octopool/blob/main/percent%25.txt",
      git_url:
        "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
      download_url: "https://raw.githubusercontent.com/openclaw/octopool/main/percent%25.txt",
      _links: {
        self: "https://api.github.com/repos/openclaw/octopool/contents/percent%25.txt?ref=main",
        git: "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
        html: "https://github.com/openclaw/octopool/blob/main/percent%25.txt",
      },
    },
  },
  {
    label: "space",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/My%20File.md",
      query: {
        ref: "main",
      },
    },
    body: {
      type: "file",
      encoding: "base64",
      name: "My File.md",
      path: "My File.md",
      sha: "a41c182af24c4b6d785ce3df3490d5f894b23e08",
      size: 3,
      content: "AP9B",
      url: "https://api.github.com/repos/openclaw/octopool/contents/My%20File.md?ref=main",
      html_url: "https://github.com/openclaw/octopool/blob/main/My%20File.md",
      git_url:
        "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
      download_url: "https://raw.githubusercontent.com/openclaw/octopool/main/My%20File.md",
      _links: {
        self: "https://api.github.com/repos/openclaw/octopool/contents/My%20File.md?ref=main",
        git: "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
        html: "https://github.com/openclaw/octopool/blob/main/My%20File.md",
      },
    },
  },
  {
    label: "Unicode",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/caf%C3%A9%F0%9F%A6%9E.txt",
      query: {
        ref: "main",
      },
    },
    body: {
      type: "file",
      encoding: "base64",
      name: "café🦞.txt",
      path: "café🦞.txt",
      sha: "a41c182af24c4b6d785ce3df3490d5f894b23e08",
      size: 3,
      content: "AP9B",
      url: "https://api.github.com/repos/openclaw/octopool/contents/caf%C3%A9%F0%9F%A6%9E.txt?ref=main",
      html_url: "https://github.com/openclaw/octopool/blob/main/caf%C3%A9%F0%9F%A6%9E.txt",
      git_url:
        "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
      download_url:
        "https://raw.githubusercontent.com/openclaw/octopool/main/caf%C3%A9%F0%9F%A6%9E.txt",
      _links: {
        self: "https://api.github.com/repos/openclaw/octopool/contents/caf%C3%A9%F0%9F%A6%9E.txt?ref=main",
        git: "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
        html: "https://github.com/openclaw/octopool/blob/main/caf%C3%A9%F0%9F%A6%9E.txt",
      },
    },
  },
  {
    label: "nested combined",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/docs/a%23b%3Fc%25%20name%F0%9F%A6%9E.txt",
      query: {
        ref: "feature/topic&mode=fast#part",
      },
    },
    body: {
      type: "file",
      encoding: "base64",
      name: "a#b?c% name🦞.txt",
      path: "docs/a#b?c% name🦞.txt",
      sha: "a41c182af24c4b6d785ce3df3490d5f894b23e08",
      size: 3,
      content: "AP9B",
      url: "https://api.github.com/repos/openclaw/octopool/contents/docs/a%23b%3Fc%25%20name%F0%9F%A6%9E.txt?ref=feature%2Ftopic%26mode%3Dfast%23part",
      html_url:
        "https://github.com/openclaw/octopool/blob/feature/topic%26mode%3Dfast%23part/docs/a%23b%3Fc%25%20name%F0%9F%A6%9E.txt",
      git_url:
        "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
      download_url:
        "https://raw.githubusercontent.com/openclaw/octopool/feature/topic%26mode%3Dfast%23part/docs/a%23b%3Fc%25%20name%F0%9F%A6%9E.txt",
      _links: {
        self: "https://api.github.com/repos/openclaw/octopool/contents/docs/a%23b%3Fc%25%20name%F0%9F%A6%9E.txt?ref=feature%2Ftopic%26mode%3Dfast%23part",
        git: "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
        html: "https://github.com/openclaw/octopool/blob/feature/topic%26mode%3Dfast%23part/docs/a%23b%3Fc%25%20name%F0%9F%A6%9E.txt",
      },
    },
  },
  {
    label: "literal percent escape",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/literal%2523.txt",
      query: {
        ref: "main",
      },
    },
    body: {
      type: "file",
      encoding: "base64",
      name: "literal%23.txt",
      path: "literal%23.txt",
      sha: "a41c182af24c4b6d785ce3df3490d5f894b23e08",
      size: 3,
      content: "AP9B",
      url: "https://api.github.com/repos/openclaw/octopool/contents/literal%2523.txt?ref=main",
      html_url: "https://github.com/openclaw/octopool/blob/main/literal%2523.txt",
      git_url:
        "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
      download_url: "https://raw.githubusercontent.com/openclaw/octopool/main/literal%2523.txt",
      _links: {
        self: "https://api.github.com/repos/openclaw/octopool/contents/literal%2523.txt?ref=main",
        git: "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
        html: "https://github.com/openclaw/octopool/blob/main/literal%2523.txt",
      },
    },
  },
  {
    label: "query-sensitive ref",
    request: {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: {
        ref: "feature/topic&mode=fast#part",
      },
    },
    body: {
      type: "file",
      encoding: "base64",
      name: "README.md",
      path: "README.md",
      sha: "a41c182af24c4b6d785ce3df3490d5f894b23e08",
      size: 3,
      content: "AP9B",
      url: "https://api.github.com/repos/openclaw/octopool/contents/README.md?ref=feature%2Ftopic%26mode%3Dfast%23part",
      html_url:
        "https://github.com/openclaw/octopool/blob/feature/topic%26mode%3Dfast%23part/README.md",
      git_url:
        "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
      download_url:
        "https://raw.githubusercontent.com/openclaw/octopool/feature/topic%26mode%3Dfast%23part/README.md",
      _links: {
        self: "https://api.github.com/repos/openclaw/octopool/contents/README.md?ref=feature%2Ftopic%26mode%3Dfast%23part",
        git: "https://api.github.com/repos/openclaw/octopool/git/blobs/a41c182af24c4b6d785ce3df3490d5f894b23e08",
        html: "https://github.com/openclaw/octopool/blob/feature/topic%26mode%3Dfast%23part/README.md",
      },
    },
  },
] as const;
