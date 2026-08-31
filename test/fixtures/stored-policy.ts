export const restrictivePolicy = {
  allowed_owners: ["openclaw"],
  allow_public_repos: false,
  allow_search: false,
  allow_logs: false,
};

export const malformedStoredPolicies = [
  { name: "invalid JSON", raw: '{"private-policy-marker":' },
  ...[null, [], ["openclaw"], "private-policy-marker", false, 42].map((root) => ({
    name: `root ${JSON.stringify(root)}`,
    raw: JSON.stringify(root),
  })),
  ...["allow_public_repos", "allow_search", "allow_logs"].flatMap((field) =>
    ["false", null, 0, [], {}].map((value) => ({
      name: `${field}=${JSON.stringify(value)}`,
      raw: JSON.stringify({ ...restrictivePolicy, [field]: value }),
    })),
  ),
  ...[
    "openclaw",
    null,
    false,
    42,
    {},
    [42],
    ["openclaw", 42],
    ["openclaw", null],
    ["openclaw", false],
    ["openclaw", {}],
    ["openclaw", []],
  ].map((allowed_owners) => ({
    name: `allowed_owners=${JSON.stringify(allowed_owners)}`,
    raw: JSON.stringify({ ...restrictivePolicy, allowed_owners }),
  })),
];
