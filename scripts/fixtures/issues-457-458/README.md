# Additive measured distribution — issues #457, #458 and #460

Predecessor: issue-455 at the exact integrated commit c28568951f060f631527470a975af181113e69e7.

This layer measures 54 accepted source paths and 33 discovered top-level consumers: 13 require-only migrations and 20 explicit historical-test adapters (440/455/451-452, three CHANGELOG readers, the T0 verification pin, literal evaluation and native readonly historical registry). Existing and new source files are both censused; unknown bytes are not rewound. All 221 published fixture files remain unchanged.

Each public validator delegates through the complete predecessor once. Historical tests retain their own worlds and negative assertions. Exact current smoke text is rewound through its measured preimage before predecessor smoke delegation; baseline/foreign text is delegated unchanged. The new layer CJS, delta and focused test are outside their own measurement to avoid a hash cycle; this README is a measured new file. No behavior/CI/release result is anticipated here.

Rendered projection is measured from exact published gitarchive source c28568951f060f631527470a975af181113e69e7 (tree c64fe28d051d8e04edafe72b4077d95d0c65ee44). Both canonical host renderers use normal options and dynamic version-marker normalization. 10 changed host/source keys retain normalized target identities, multiplicity, current/predecessor byte hashes and compressed predecessor content. Only exact current postimages rewind; baseline/foreign artifacts pass unchanged. Nested historical validators project source and artifacts once. Legacy surface/golden APIs advance measured Claude surfaces; Codex measurements remain separately host-bound. Published fixtures and historical assertions stay unchanged.

Route-list provenance: `node scripts/run-tests.js --list --match xllm --match native --match codex --match claude --match sidecar` was measured without running suites or providers. The original published tree lists 51 suites, sha256 `959e1be9d5e371a4f65b9b5f69396e46fc0ed0be76dbd2229930fbf7fd96b828`; the current declared source set lists 53, sha256 `996d885521cad181dc4c6e3689dfcc76a605bdbf57f1e1f1cc10c8d22233c80c`. The only added names are `forge-native-milestone.test.js` and `forge-review-native-model.test.js`, both declared new sources. Historical440 first requires the exact measured current digest and reports current/historical hashes separately; only that digest maps to its unchanged route-matrix digest. Additional or foreign roster changes refuse.

## Measured rendered surface chain

All entries below are the exact normalized SHA256 values captured for this layer. The legacy surface/golden API follows Claude; Codex remains separately host-bound. Both raw and attributed predecessors and postimages are retained.

| Host | Surface | Raw before | Raw after | Attributed before | Attributed after |
|---|---|---|---|---|---|
| claude | agents | 309b494a7295df922a55b28d70d57332cec03f1a4ca0fc9ba6ff0a01bb787994 | e11e4f0c4e9985d25e8447e55e89588de187edbb4c39dfce8376a395cbda75fb | 309b494a7295df922a55b28d70d57332cec03f1a4ca0fc9ba6ff0a01bb787994 | e11e4f0c4e9985d25e8447e55e89588de187edbb4c39dfce8376a395cbda75fb |
| claude | dispatch-templates | d9e3a42140e1fbe113c25eac8ae6cb7fb8be46ccda1490c5ca479212406dfcb4 | 1931d8411d282e5ec71f7ea4ed78e7797656d8905aded3709cedd6c84d47e229 | d9e3a42140e1fbe113c25eac8ae6cb7fb8be46ccda1490c5ca479212406dfcb4 | 1931d8411d282e5ec71f7ea4ed78e7797656d8905aded3709cedd6c84d47e229 |
| claude | skills | d8284653f0518be4b714960167fe8fbef19aebffcd9fe7be0a335bb9ecacd230 | 3e8b6f5580b6de8084278c9b43f618447514ed390052ff17bfb6ac2053213b2f | d40164b6e32270e02a2a34ec5cd50c0d0c57c9d0dfdb355cf0812b15746f41d0 | e11aae5911ebdec9f65199ed6d861d20532d352bff45bbb2c193833668fe62a9 |
| codex | agents | a16a1622c516a23e99437e1dd0843e514236a79528150725e1955818f60802c1 | b7ebf70c76fdf3a0c5c9fa4b7993b02cd81d7ddafbcc899dbe7ae6df4c64d3ae | a16a1622c516a23e99437e1dd0843e514236a79528150725e1955818f60802c1 | b7ebf70c76fdf3a0c5c9fa4b7993b02cd81d7ddafbcc899dbe7ae6df4c64d3ae |
| codex | dispatch-templates | a6f20097a9e32eedc3711a979a65731aa9455af915522cba796cd213da0dde61 | 2ebe3b670f3d8d595cdae55b9c96ab6f06e46fbf3086de26392eebf144e61e3b | a6f20097a9e32eedc3711a979a65731aa9455af915522cba796cd213da0dde61 | 2ebe3b670f3d8d595cdae55b9c96ab6f06e46fbf3086de26392eebf144e61e3b |
| codex | skills | b0639fb17a7b4c58ad5e8916ba6502e8e1b3fec9e82928b2835966c2e30401e9 | 15458281edd61549f4c6c56c09e6497801497c001a358985b04227a10fb7c416 | 9c0a6e35c312a7e53d0a0bc7b68f4e1817d27082a1e67a8e6156170f9e7a5256 | 55d95b9afb3915bb1809c047c55ed4d82c2f59d4effb9f797c7c4b8e151207b3 |

## Curated operational registry

The real current audit is required to match 256 discovered and 256 registered candidates, with no unexpected, missing or structural errors. BASE retains 254 rows, SHA256 eed37a56b721241b38edaa6847b45e4a4b46c7e071e912666ba94c91cae67494; this layer has 256, SHA256 4c0e5fb1abf843dd022064aadc57f21fb9046d8868d4a6284fa15309c9b262a7. Twelve existing IDs retain every classification/reason/host-policy field and update only their measured fingerprints (including the two existing excluded shared-Agent examples). The two new native owner bridge directives are explicitly operational, never excluded or identity-aliased. The complete exact current array alone projects to BASE for historical consumers; baseline/foreign arrays are passed unchanged to the predecessor and retain its refusals. Current raw discovery, identity and release-gate assertions remain real. Optional registry metadata is forwarded unchanged, one predecessor traversal per view. The native-readonly test alone updates its strict real inventory assertion to 256/256 and projects only its historical owner-recovery call.

| Existing stable ID | Before fingerprint | After fingerprint |
|---|---|---|
| shared-forge-review-md-agent-c8e16be038a5 | sha256:c8e16be038a549ec49ae8c401cbcadfbba3c7e54de9fed14a05ce8082a1970a4 | sha256:63e40e16d95856f7c9ff19d983b6fb75a8368761356689ca4df33954bd53a76f |
| shared-forge-review-md-adapter-1663e7973eb4 | sha256:79636a9552ff964de468cf1ebe8bdb76b6e59dba9bdd32f7e5f67eb9c22d8fdf | sha256:b48c1bfc806a6ad37d1e44c66d1d61edec48a266be34623a8de5fc4ba6e6fa68 |
| shared-forge-review-md-adapter-80b8ab328a33 | sha256:ac13eb7bb88e381f0b1fcb91094460edbc55478cf3df96f652d74bea8c0e79d2 | sha256:f36a31bf6293be8ab1562e218f96d5f218a29ca3797be52515624fe7a17c8415 |
| shared-forge-review-md-adapter-d4bf88686631 | sha256:9a092a515865349e7db69fd0a9955215c5f5b8581b1ae3317c8669b9fab590f1 | sha256:515806b74140aa41686bde9f6efdf76cb213e7f1f9b2897e28ad349397fd2527 |
| shared-forge-review-md-adapter-a047198b3041 | sha256:bd4070bcb30ab040b9715cfae843caca9c4a82d929b47905efc5457236477933 | sha256:77d2239b5b4dee700c355831b168301e10d3ec488623b34c3183e95dab2d0ad6 |
| shared-forge-review-md-agent-b6c13c343eab | sha256:b6c13c343eab55aba0d6e77573c4631ea72549b29863fb89ba0009dfb0f16cd2 | sha256:ab9f6c2a76c1837268d7bd73e8b731eae728b464e2aef198298e8cd7902d5925 |
| shared-forge-review-md-adapter-ceff851a7b09 | sha256:630b4983ea980cfcd3d015e071b29fe8a1eb0942390ce944efd1b6d5544a2c1d | sha256:6df3324296371be302c119f8414f6fe1524931e6a119c3e96c4218397f322961 |
| shared-forge-review-md-adapter-bc8da1622714 | sha256:4862f130d0f696b7f430e927b649eb2b45579f20d7e4742b1f503ce869b1e010 | sha256:6461f1aaec01429735d6420aae0b1301c8863c29871b76f35f713e3cd6a38a95 |
| skills-forge-auto-skill-md-agent-c7eed1171094 | sha256:c7eed1171094162634ed4abbb4ad70973174dc0e9c24384c34f22f769ebaa31a | sha256:a26689638e51816eff952862ac05204adc99c3c49fd7e8839c18f415b4819fd8 |
| skills-forge-auto-skill-md-agent-b075961299dc | sha256:b075961299dc1f22d19ae51c84ce4f3417482cd2f25c75522e062e3e6fc4ace0 | sha256:97943ffefa816f9af850594343ce6264b88f56fef80c56f562f6813ef224a4e2 |
| skills-forge-next-skill-md-agent-0e1ffac761e0 | sha256:0e1ffac761e01f01b511a14eae06d36f36065fc4dffd9a092ee7eddd61326f81 | sha256:d76d53f0d3d8e5f52d5ee5ea1a63aa765733e77e9a51facbdfbc98783a733d53 |
| skills-forge-next-skill-md-agent-ab7dff4fca01 | sha256:ab7dff4fca01aba4a7d616ece482108c6bb1d8afd83c7ac877b4f1d4b98a014b | sha256:b347216a6e7d9bbbf00441143e3bb79b4dcbf7561d8c06de4b523dbbbf1cf050 |

New operational native owner bridge: skills-forge-auto-skill-md-native-70182a11d934 (skills/forge-auto/SKILL.md, sha256:70182a11d934f0903182005d953f3b3de8f24919ba064de64e086e59b6a0427c).

New operational native owner bridge: skills-forge-next-skill-md-native-dae01f2aa3f7 (skills/forge-next/SKILL.md, sha256:dae01f2aa3f7bc7e4b50dcdbac10efdf85ede73829b957d9363ec05b5d9aeab4).

Issue #460 personal namespace concurrency correction is included in this same unmerged measured layer. Its actual reviewed runtime/test/documentation bytes are recorded in the final source roster; the original 221 published fixture files and predecessor remain unchanged.

Private historical loader: only the independently pinned original221fixture modules/data are loaded in a private CommonJS graph/cache. Only that historical context receives the exact measured BASE registry; actual SOURCE_REGISTRY and audit remain current. Its scoped module.createRequire preserves old376 isolation and runtime reads; direct historical consumers/focused counters share that private graph. No global require.cache/Module._cache assignment or fixture byte change is used. Fourteen exact real callsites and two own focused references migrate; embedded historical mutation/assertion strings remain intact. Unknown paths, changed pins, external modules and foreign registries retain refusal. Compile-only is not a successful import or test; root must first run the private proposed-module smoke before live apply.

Historical citation adapters: SourceGuard projects only the exact current Next row at its manual #341 digest comparison. CommunicationSurfaces retains actual rawHash, attribution, sourceBytes override precedence, literal text and state; a separate exact measured Next citationRawHash admits the historical corpus alongside the original actual-current positives. Other sources and foreign buffers retain refusal. Old440 projects only the two expected parent-registry right-hand operands; actual rows256 on the left, optional metadata and forged-metadata refusal remain untouched. Corpus, historical hashes, registry audit and published fixtures are unchanged. The explicit union is20 of33;13 remain require-only,62 literal consumer edits total.

The current two-host test now preserves each actual Claude renderer artifact with {...row}, including bytes/origin/newline. No host metadata is fabricated: exact own measured artifact projection remains enforcing; current rendering/content and all unknown/baseline refusal contracts are unchanged.

The T06 synthetic current-attributed positive supplies its matching canonical task/next attribution hashes together with the complete historical sample README, matching the existing raw-view positive. Generic validators, corpus, default fixtures and negative bodies remain unchanged.
