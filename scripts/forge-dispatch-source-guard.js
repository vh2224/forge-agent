#!/usr/bin/env node
'use strict';

// Release gate for the renderer-owned dispatch migration.  It intentionally
// uses only Node built-ins so it can run in a fresh worktree.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECTED_SKILLS = Object.freeze([
  'skills/forge-auto/SKILL.md',
  'skills/forge-next/SKILL.md',
  'skills/forge-task/SKILL.md',
]);

const SHARED_SPECS = Object.freeze([
  'shared/forge-dispatch.md',
  'shared/forge-review.md',
  'shared/forge-sidecar-auto.md',
  'shared/forge-sidecar-next.md',
]);

const SCOPED_FILES = Object.freeze([...PROJECTED_SKILLS, ...SHARED_SPECS]);
const AGENT_FILES = new Set([...PROJECTED_SKILLS, 'shared/forge-dispatch.md', 'shared/forge-review.md']);
const ADAPTER_FILES = new Set([
  ...PROJECTED_SKILLS,
  'shared/forge-dispatch.md',
  'shared/forge-review.md',
  'shared/forge-sidecar-auto.md',
  'shared/forge-sidecar-next.md',
]);

const MARKER_START = '<!-- forge:dispatch:start -->';
const MARKER_END = '<!-- forge:dispatch:end -->';
const TOKEN = Object.freeze({
  resolver: /forge-dispatch-resolve\.js/g,
  agent: /Agent\(/g,
  adapter: /forge-xllm\.js/g,
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// Each row is immutable evidence, not an expectation derived from the disk.
// Fingerprints are populated from the measured canonical sources below.
const REGISTRY_ROWS = [
  ["shared-forge-dispatch-md-agent-fe77b6a6f402","shared/forge-dispatch.md","agent","excluded","sha256:fe77b6a6f40224c2e1262832a54efc14e6b20d255398095162ecfbb7356b7fd6","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-bf5525b8fdba","shared/forge-dispatch.md","agent","excluded","sha256:bf5525b8fdba901c3f8c4976ac07f3847ce70615a3d66aefed573503be310846","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-c5948d9c7b7a","shared/forge-dispatch.md","agent","excluded","sha256:c5948d9c7b7ae83b78b963c109d457970b85a81dea76068c49475fb67046735c","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-c9b344797313","shared/forge-dispatch.md","agent","excluded","sha256:c9b3447973130af571168f8f7b5c45c4f17d087a95010efa3d69a5d012d10641","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-91e9a1ccae9b","shared/forge-dispatch.md","agent","excluded","sha256:91e9a1ccae9bbcafb2626a36b116ba0b33f55dc08fde3372aa306e6f7766c8b6","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-a6c9b4d6763b","shared/forge-dispatch.md","agent","excluded","sha256:a6c9b4d6763b99a547a7b5e489a60bb8a0f5bb37627be82ec970467a1b1c5127","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-21695fd63e56","shared/forge-dispatch.md","agent","excluded","sha256:21695fd63e56cab914e06e8fdff2a40b54dfe2771ae741839a2f88faaed53f94","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-6ca20cc36477","shared/forge-dispatch.md","agent","excluded","sha256:6ca20cc36477544ba92c4eee4a2b8867c5c8644f6f0f9bf2fe54c699b3dd5c6d","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-1cd1fc3821fe","shared/forge-dispatch.md","agent","excluded","sha256:1cd1fc3821fe060ae2a955d739ac8cce5516cb3d7ca379863ce83483f7017cf7","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-adapter-54deee706239","shared/forge-dispatch.md","adapter","excluded","sha256:54deee70623947f9267a45eb205ae9db7699dbc7dbe6685c5d54e1852a67384e","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-dispatch-md-adapter-e44261509cec","shared/forge-dispatch.md","adapter","excluded","sha256:e44261509ceccce292e45e7ffd3817b5ce814f24e87ae96652bebf8802d7a7fa","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-dispatch-md-resolver-e17a0233cf0c","shared/forge-dispatch.md","resolver","excluded","sha256:e17a0233cf0c6dbf52d35cdf046d06afc362108eb0f8161096020b46dfd03ea9","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-resolver-d722111d1ede","shared/forge-dispatch.md","resolver","excluded","sha256:d722111d1ede3037094c8167f41fc0bb29eb03b6f4cb92bf584b80287d313fb9","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-adapter-e3fcf66632d9","shared/forge-dispatch.md","adapter","excluded","sha256:e3fcf66632d9747a5c536c344fd40189e8d8080b9fb9ed8df6710786bca87bca","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-dispatch-md-resolver-fb305a3a68a3","shared/forge-dispatch.md","resolver","excluded","sha256:fb305a3a68a3b058d557321bab371b7c7a4f10d290edc7b827b56244509e5f3c","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-resolver-7fd78f107737","shared/forge-dispatch.md","resolver","excluded","sha256:7fd78f107737bc97912765b8636d45f1f22b92ac01f7d4bb0bc38d563aef9e34","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-resolver-d51c0fdd67da","shared/forge-dispatch.md","resolver","excluded","sha256:d51c0fdd67da7b53fc130290b695b965ac62a3d4bdde7ba36cc08574dcdcc557","explanatory argv example; it is not a production resolver site",""],
  ["shared-forge-dispatch-md-agent-1189f95833a2","shared/forge-dispatch.md","agent","excluded","sha256:1189f95833a2d90b8cf09a8b63de91fee29078d073b1d5ccf4dc9bc850469dee","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-ef1d9466d1cf","shared/forge-dispatch.md","agent","excluded","sha256:ef1d9466d1cf140cca62fb6ab5ccb418a3fcbda8b43c70620f0a4764d5613403","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-be5357e0d031","shared/forge-dispatch.md","agent","excluded","sha256:be5357e0d0310950ff368b996b0a8c2e5c68ba3dc2edc7796c979f862873cda4","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-adapter-ebd721fdbcc5","shared/forge-dispatch.md","adapter","excluded","sha256:ebd721fdbcc51c624bc5b151e1a256fce1333ab5af5cd78d7b64998707dd7383","filesystem path probe; it does not invoke the adapter",""],
  ["shared-forge-dispatch-md-adapter-2f891384bb70","shared/forge-dispatch.md","adapter","operational","sha256:2f891384bb70acab18cfd24220ccb3017632ad77f55b8da5a1b4472f67153ffc","",""],
  ["shared-forge-dispatch-md-agent-8d5f61ec4e24","shared/forge-dispatch.md","agent","excluded","sha256:8d5f61ec4e246e38125fe35694b56ebc0e9050a84fb964c502884ebe14ee1601","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-7d23ae247e88","shared/forge-dispatch.md","agent","excluded","sha256:7d23ae247e883000e2cdd0a77e8eeed05a46cb58b9af0512794429dff5a8a15a","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-adapter-ee636e53fc92","shared/forge-dispatch.md","adapter","excluded","sha256:ee636e53fc92b51c8900aec6313b1e89bf52367ab4c03fc29906e0e3b857cfec","filesystem path probe; it does not invoke the adapter",""],
  ["shared-forge-dispatch-md-adapter-5f151260c9e8","shared/forge-dispatch.md","adapter","operational","sha256:5f151260c9e81f3a9d276fa7a65e44cd104586d4741916597110742a4963242d","",""],
  ["shared-forge-dispatch-md-adapter-477b8231818e","shared/forge-dispatch.md","adapter","excluded","sha256:477b8231818e6410a74cc4411fe6d48ca0eaf55571ab1031018807c21bcfcb66","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-dispatch-md-agent-18c55b169106","shared/forge-dispatch.md","agent","excluded","sha256:18c55b1691065931c50f762337c4f37c188f7b09159558fb3326418fda04a2d4","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-adapter-b07fdde89f9b","shared/forge-dispatch.md","adapter","excluded","sha256:b07fdde89f9b9bec3bba6da17990358762e4d38388d5aa3ed7aa58c448616e19","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-dispatch-md-agent-e0b484d12dfb","shared/forge-dispatch.md","agent","excluded","sha256:e0b484d12dfb59e7cb21ed4b4aa890255673f5f8d749b1c2a568a3df158adf77","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-ae7cd6773c05","shared/forge-dispatch.md","agent","excluded","sha256:ae7cd6773c05265b2c8d62d7d10962806131769fefdb4a54dcd0a39d3690010c","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-resolver-1358d43179b0","shared/forge-dispatch.md","resolver","excluded","sha256:1358d43179b0892f363524578b235f21d8ad1d5be23389ffac84c00eb6a24999","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-agent-c5af8de86694","shared/forge-dispatch.md","agent","excluded","sha256:c5af8de86694bc8425928dbab34fb196b680a8ddb997017117bad52d2422e96a","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-df6305e3ec03","shared/forge-dispatch.md","agent","excluded","sha256:df6305e3ec0391706995c936693e5b9ef1c45cb0107a141cfd2a764ce7238536","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-resolver-90bdf0bdd3a4","shared/forge-dispatch.md","resolver","excluded","sha256:90bdf0bdd3a4a7abd7501f58da43f2bbab329167fe97995d40667aee0acdc224","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-resolver-397437803640","shared/forge-dispatch.md","resolver","excluded","sha256:397437803640b7a8f07476bf99b0ee5c6b72fe77714c3145e0f62c7a963e1042","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-agent-d1e76cf2c32a","shared/forge-dispatch.md","agent","excluded","sha256:d1e76cf2c32a7b9e8edbc40a49c3c2320ffa2b50623db5a09a141b2421970e26","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-resolver-cbeb8d0b962d","shared/forge-dispatch.md","resolver","excluded","sha256:cbeb8d0b962da1655158d60c1c91c403f70cd6a4959965d005c768b7bd6c3fc8","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-resolver-71c16b60dd4b","shared/forge-dispatch.md","resolver","excluded","sha256:71c16b60dd4bfd58d296ed03c9fdcf52888758817217f881f294cc230446422f","filesystem path probe; it does not invoke the resolver",""],
  ["shared-forge-dispatch-md-resolver-1450d3fdb3ca","shared/forge-dispatch.md","resolver","operational","sha256:1450d3fdb3ca70dfce28dd8c44c03a53a65ef0444cf67daec4ddc023affd5c0b","","canonical"],
  ["shared-forge-dispatch-md-resolver-dfb6358a018c","shared/forge-dispatch.md","resolver","excluded","sha256:dfb6358a018ce22bcc24ed830c721e3251f8bdb1d303ab85c2298f1df694c95d","diagnostic text naming the resolver; it launches no process",""],
  ["shared-forge-dispatch-md-resolver-0351b9333ba6","shared/forge-dispatch.md","resolver","excluded","sha256:0351b9333ba61b55fdd813ee28181a4e464da10284fe668171b97a4898cea0f5","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["shared-forge-dispatch-md-agent-484b335e2f28","shared/forge-dispatch.md","agent","excluded","sha256:484b335e2f285061defc179782ecc4009247b3021f111d9d2df745b5603826c1","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-9d84d1006747","shared/forge-dispatch.md","agent","excluded","sha256:9d84d1006747e186a51d5607440ddfded1c0358eb9af59c11f219ec56ba7fabe","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-emitter-cc6b63db03ab","shared/forge-dispatch.md","emitter","operational","sha256:cc6b63db03ab28a04489b4edee7e6c0f81410859cb433128083e25aa6a148b58","",""],
  ["shared-forge-dispatch-md-resolver-55f98edf015c","shared/forge-dispatch.md","resolver","excluded","sha256:55f98edf015caf5056d87fbf096db1d66b6f9c430fce2536a0432825d1879e49","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-agent-b3f31f6c9ae1","shared/forge-dispatch.md","agent","excluded","sha256:b3f31f6c9ae1facb2da76a9afd734d2c2099fec4bd491849e331b60a3a29e18f","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-resolver-01679ba2e209","shared/forge-dispatch.md","resolver","excluded","sha256:01679ba2e209570e28fd60b76c5c54dd92506976947ccd4c4cd39c8f0919c874","documentation or explanatory resolver reference; it launches no process",""],
  ["shared-forge-dispatch-md-agent-27aed9c637cd","shared/forge-dispatch.md","agent","excluded","sha256:27aed9c637cdf0f26d36b52202d79f7f9b0d6bfa3c6f3c21facaad59ff0770ea","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-ff9c5aed9f0e","shared/forge-dispatch.md","agent","excluded","sha256:ff9c5aed9f0e3806698bfa7da9abedb43592e908d44b64de29a75b6a7de2e03a","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-31233ba043d2","shared/forge-dispatch.md","agent","excluded","sha256:31233ba043d2df731aaa44dd34f59a82ed5a3ab7b6e9dc5b68a5e457fd6421ef","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-312b238e3bf5","shared/forge-dispatch.md","agent","excluded","sha256:312b238e3bf538cf6ee9e01dd2b7b1b0e4b83c30b301a4c470a4af73d22ad7ac","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-dcc6aba59aa6","shared/forge-dispatch.md","agent","excluded","sha256:dcc6aba59aa6714727b82ef7a4762f8b33fa790740af56c482d35cb7109674a3","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-d33cd796fdf6","shared/forge-dispatch.md","agent","excluded","sha256:d33cd796fdf6a18a601e4cdcd675c6b06b3b56b892636ba292a816471951013d","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-e93a4646dd64","shared/forge-dispatch.md","agent","excluded","sha256:e93a4646dd6493ce2142f88cfa5b12e2558d9d2516a52344796cd4ed04d62108","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-b45588005d7f","shared/forge-dispatch.md","agent","excluded","sha256:b45588005d7f1940ea8afa6680ffd69cbd1b59dd999b0c3f8ec6d9da9cab5548","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-829904a3c30b","shared/forge-dispatch.md","agent","excluded","sha256:829904a3c30bfbf9b2ab8687afc3d904d59b410fd06527ec0f510058c7d3d2c0","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-aa1cbc5a83f5","shared/forge-dispatch.md","agent","excluded","sha256:aa1cbc5a83f5f4a6fec660ffad22bdf6956e736a5cd9d35abb653c161284d9ff","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-f456f34eae4e","shared/forge-dispatch.md","agent","excluded","sha256:f456f34eae4e490c102be26ea31dfdd76a35b85a13b43e8d08d25393ec90222e","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-3e1cf340ebb1","shared/forge-dispatch.md","agent","excluded","sha256:3e1cf340ebb14bfe21bc2e68497a90d00879db8f57ae4fb89505e3e5734d6aa1","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-a9fc75b5d2bc","shared/forge-dispatch.md","agent","excluded","sha256:a9fc75b5d2bccf279cb5c3eeb1aab36640f8e1637ab18fa8f5e5630dc5d905a2","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-f0a68b4080e4","shared/forge-dispatch.md","agent","excluded","sha256:f0a68b4080e4f1c4bb29019fee57af8c5fd486340c7cf13cb684cc54145e4c51","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-dispatch-md-agent-c9c06e3dd2a0","shared/forge-dispatch.md","agent","excluded","sha256:c9c06e3dd2a062c641da6063572a4184972dd8a979d3354a03d80da2eb1417bf","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-adapter-c81fc5932505","shared/forge-review.md","adapter","excluded","sha256:c81fc5932505826fbd1f11acb945723d2992fcb41d9a49c8cacef2c68507af40","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-review-md-adapter-b1d697f4dec9","shared/forge-review.md","adapter","excluded","sha256:b1d697f4dec9a85dd909494626f04390e3cde7710b4e4a2be4c0ad8c01c16e74","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-review-md-adapter-c6acbaca3ddf","shared/forge-review.md","adapter","excluded","sha256:c6acbaca3ddffdf585ab6feb9254cbd9c2e686920ca63190a5ece7f30cca3b4a","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-review-md-adapter-419970517620","shared/forge-review.md","adapter","excluded","sha256:4199705176208495459603644b6692b830acadcec40e6eb84d8c14ddcc4ac381","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-review-md-agent-c9cf2c6ec77f","shared/forge-review.md","agent","excluded","sha256:c9cf2c6ec77fb43b0ac9b055544d1527ca21b09c7b783c92f360b88049270dc9","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-fcd917cae3d2","shared/forge-review.md","agent","excluded","sha256:fcd917cae3d2489ae17813603a1f76aca94fe6e8044778becd8ab0b627954404","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-b0d000c3eadf","shared/forge-review.md","agent","excluded","sha256:b0d000c3eadfe83b5db27f49fa002a4e971b44cdd6a890b3727b34fdc1f1f037","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-db4ab4093f79","shared/forge-review.md","agent","excluded","sha256:db4ab4093f7978280dac15ad773ecf88558363a6a9703cc23039c86cafd9e2c1","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-c8e16be038a5","shared/forge-review.md","agent","excluded","sha256:c8e16be038a549ec49ae8c401cbcadfbba3c7e54de9fed14a05ce8082a1970a4","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-401fdc21e032","shared/forge-review.md","agent","excluded","sha256:401fdc21e03200821b3ce39bb9398ea5ad80ef9fb06dc7b1eef9c5cda1121d1c","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-c93590ac711d","shared/forge-review.md","agent","excluded","sha256:c93590ac711d7cefcaf4f62ead1a1ee92064b5f08988503adbf818b339e92f22","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-adapter-9a1f25449bb6","shared/forge-review.md","adapter","excluded","sha256:9a1f25449bb61a70d357cc4681ac041e8a93eb23feccd81040442b6b5eb2fb37","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-review-md-adapter-4a0e979010fe","shared/forge-review.md","adapter","operational","sha256:4a0e979010fea54738b337b25a8192af3ba3130e0abb83ed0626586c184f52d8","",""],
  ["shared-forge-review-md-adapter-83ceceda44cc","shared/forge-review.md","adapter","operational","sha256:83ceceda44ccc054e55aab6dc6f9321aa09b7815b133c3db0105369cb2837451","",""],
  ["shared-forge-review-md-agent-ff26e0f4a183","shared/forge-review.md","agent","excluded","sha256:ff26e0f4a18392d14a7b578dcfcf1abd7cec382be9f81a920a79a682b2a526ba","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-adapter-0344a5848a50","shared/forge-review.md","adapter","operational","sha256:0344a5848a507bc9473de51a4c8125e7fcf3ab661c35a669295df94a48658a51","",""],
  ["shared-forge-review-md-adapter-5b82b20d45b9","shared/forge-review.md","adapter","operational","sha256:5b82b20d45b99c06f187c855b781fd9627df1e04ea1f3a1c164129d224853a9d","",""],
  ["shared-forge-review-md-agent-ece58c9ec69b","shared/forge-review.md","agent","excluded","sha256:ece58c9ec69b4194f7cf3949d1ee290f5ac00714f2967ecab504c89768864790","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-7f1505cb173c","shared/forge-review.md","agent","excluded","sha256:7f1505cb173c8e36dc7d05e69c20bc28caab92d0d0083bcf66be1c4be23f1dd4","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-e10d63abd72f","shared/forge-review.md","agent","excluded","sha256:e10d63abd72fa13f57cf8284392c2e2947ea276f43bfb661a3b50a682edf2033","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-2b6578d8ad94","shared/forge-review.md","agent","excluded","sha256:2b6578d8ad94a162a793dea5810b0781ed4d641633dc69fdf1975e7b20a1ca07","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-b6c13c343eab","shared/forge-review.md","agent","excluded","sha256:b6c13c343eab55aba0d6e77573c4631ea72549b29863fb89ba0009dfb0f16cd2","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-adapter-f2f2ffeb20cd","shared/forge-review.md","adapter","operational","sha256:f2f2ffeb20cd17ae75392f0ea166c2679b6bf249844ed0474c73c499e4b1f7fd","",""],
  ["shared-forge-review-md-adapter-b02e3430e7d4","shared/forge-review.md","adapter","operational","sha256:b02e3430e7d47454618ed0d8dc39cfb3e849822a2581d181847e1bd0f55d1569","",""],
  ["shared-forge-review-md-agent-f0a86c73f06b","shared/forge-review.md","agent","excluded","sha256:f0a86c73f06b175b20466fa9e95383ac2c4e23e84f353fa2456afba805cb5ba9","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-resolver-3b7a44d31fc6","shared/forge-review.md","resolver","operational","sha256:3b7a44d31fc66cd34fb57be153b4c044298d1458265c70c0f965a366dac77caa","","canonical"],
  ["shared-forge-review-md-resolver-141a058b1c4c","shared/forge-review.md","resolver","excluded","sha256:141a058b1c4c83f811ee9e6849ce4b936135057186853374c0d5e21d28ac4a7d","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["shared-forge-review-md-agent-e8b165a5f6a9","shared/forge-review.md","agent","excluded","sha256:e8b165a5f6a9bb00a1a80b9de1e7a2dd6284a5f765f1c1a1c9a8eba0883b4c69","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-fbc054284fbd","shared/forge-review.md","agent","excluded","sha256:fbc054284fbd12f4ceb5127c48d529530ed87b83e69097497563e0936e1ec966","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-e53e46229443","shared/forge-review.md","agent","excluded","sha256:e53e462294439b31b41e794141a6cac13e2afc33b730831070d4113c47a41313","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-agent-fcb53727d228","shared/forge-review.md","agent","excluded","sha256:fcb53727d228829febf5e501ed39d347c1618bf149bc7fbfa6699b4706497e58","non-projected shared Agent prose or example; renderer ownership does not include this token",""],
  ["shared-forge-review-md-adapter-beb38f7afb16","shared/forge-review.md","adapter","excluded","sha256:beb38f7afb16c557cc953914e75dafbc24940730dd32e4802e4e3ea9ba1e36dd","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-sidecar-auto-md-adapter-c873049ea75f","shared/forge-sidecar-auto.md","adapter","operational","sha256:c873049ea75f1d94731f4266ab360ae0027edde72b540f97f1e2c9aaac7720fa","",""],
  ["shared-forge-sidecar-auto-md-emitter-c606ed2eb90a","shared/forge-sidecar-auto.md","emitter","operational","sha256:c606ed2eb90a0c3db0b8b7e314ee6f66d01c8b929d475e08c9d25a93c0908e60","",""],
  ["shared-forge-sidecar-auto-md-resolver-2c9523d5df84","shared/forge-sidecar-auto.md","resolver","operational","sha256:2c9523d5df845d5577f3155d142bb2630a180081ca8ea722da18fba4d69c16f6","","inherited"],
  ["shared-forge-sidecar-auto-md-resolver-cdc2df692d26","shared/forge-sidecar-auto.md","resolver","excluded","sha256:cdc2df692d26decb48a5d1aab76ab9459e8de9ea0304527a3ff3892a5b665e9b","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["shared-forge-sidecar-auto-md-resolver-f05bb7f5159d","shared/forge-sidecar-auto.md","resolver","operational","sha256:f05bb7f5159d53af699898a3d011a26454d98def52636f043beb18a14dc4e39d","","inherited"],
  ["shared-forge-sidecar-auto-md-resolver-0c39fc86032c","shared/forge-sidecar-auto.md","resolver","excluded","sha256:0c39fc86032c98a9e8fc31e5eb0786efd182f1af449974506d44b4ffbb5d86ee","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["shared-forge-sidecar-auto-md-adapter-8cf7ff758ee9","shared/forge-sidecar-auto.md","adapter","excluded","sha256:8cf7ff758ee950abdcaf7f30608d37b46ab2fe9ab1f9435855add4008c76a9f7","filesystem path probe; it does not invoke the adapter",""],
  ["shared-forge-sidecar-auto-md-adapter-1fb8ccc09ad4","shared/forge-sidecar-auto.md","adapter","operational","sha256:1fb8ccc09ad4905fd979354303928567b031b82c4ab18674bad49ccce13b7068","",""],
  ["shared-forge-sidecar-auto-md-adapter-7e1908fcaa2f","shared/forge-sidecar-auto.md","adapter","excluded","sha256:7e1908fcaa2f85e161d7a31d37b68f6b40db4d28c2c9766533f7e7611b161300","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-sidecar-auto-md-emitter-5f59c6e9b4b7","shared/forge-sidecar-auto.md","emitter","operational","sha256:5f59c6e9b4b7c2f6f3c9a19f707532f9a66fc5c2de9679922d191d623b3aeec4","",""],
  ["shared-forge-sidecar-auto-md-resolver-e06cc71760dd","shared/forge-sidecar-auto.md","resolver","operational","sha256:e06cc71760dd5c98a9e76d9026a5d1dfe8602da4f5fe8751b0728b50faacbd56","","inherited"],
  ["shared-forge-sidecar-auto-md-resolver-25a585ec6e24","shared/forge-sidecar-auto.md","resolver","excluded","sha256:25a585ec6e24f0ec41121c3daed9a1c3a9cb041c8b64279db3bd09f8dc924d6a","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["shared-forge-sidecar-auto-md-resolver-bd4e78c9614d","shared/forge-sidecar-auto.md","resolver","operational","sha256:bd4e78c9614da28d56817b67057a2d1923ec4f8b0c70745f6deb22c0b12cd2d9","","inherited"],
  ["shared-forge-sidecar-auto-md-resolver-9586ab94e367","shared/forge-sidecar-auto.md","resolver","excluded","sha256:9586ab94e3675b4bd8b37240eb51f4881cd94d768e239cbff739d28e5fa8e8fb","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["shared-forge-sidecar-next-md-adapter-7fa55e84460d","shared/forge-sidecar-next.md","adapter","operational","sha256:7fa55e84460d1bde5c5596b14bba9fd72ad9c7517f001a5e9660e918bea733b0","",""],
  ["shared-forge-sidecar-next-md-emitter-a816486a2fe2","shared/forge-sidecar-next.md","emitter","operational","sha256:a816486a2fe2ec259884eea38df08ec7c6200d85e8a4ea4af849ae6e25659906","",""],
  ["shared-forge-sidecar-next-md-resolver-261c74db6140","shared/forge-sidecar-next.md","resolver","operational","sha256:261c74db61408bd63b05cfde148a2270ca30938c5e1cd03f8d617a5db5a4cfcd","","inherited"],
  ["shared-forge-sidecar-next-md-resolver-be270c8cc618","shared/forge-sidecar-next.md","resolver","excluded","sha256:be270c8cc618e6e6f969dda9725d8f8c77f1b102f08067b433c9c3395a788b5b","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["shared-forge-sidecar-next-md-adapter-5a891aabee7e","shared/forge-sidecar-next.md","adapter","excluded","sha256:5a891aabee7e78937d3c3169de9d79a49ce651928791ffcedda33b20b7756e5b","filesystem path probe; it does not invoke the adapter",""],
  ["shared-forge-sidecar-next-md-adapter-f96911116657","shared/forge-sidecar-next.md","adapter","operational","sha256:f96911116657ffd76bf48a325b43a9e23c206ef0e98e0bbf2f2eb100a96adcca","",""],
  ["shared-forge-sidecar-next-md-adapter-7e1908fcaa2f","shared/forge-sidecar-next.md","adapter","excluded","sha256:7e1908fcaa2f85e161d7a31d37b68f6b40db4d28c2c9766533f7e7611b161300","documentation or explanatory adapter reference; it launches no process",""],
  ["shared-forge-sidecar-next-md-emitter-dcf02745893b","shared/forge-sidecar-next.md","emitter","operational","sha256:dcf02745893bc5759c9801ce45d03576e749cc7792d24ea8b666f94dae76b078","",""],
  ["shared-forge-sidecar-next-md-resolver-1b4213f3f440","shared/forge-sidecar-next.md","resolver","operational","sha256:1b4213f3f440685f8689345c055db253d5403fbccaf1ceb91149e91eba3caeca","","inherited"],
  ["shared-forge-sidecar-next-md-resolver-0c77d217b3f5","shared/forge-sidecar-next.md","resolver","excluded","sha256:0c77d217b3f5bac61dce87d22c187c909953f6dbe389b092f65108fb7d38a77b","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-auto-skill-md-agent-b60976a18a42","skills/forge-auto/SKILL.md","agent","excluded","sha256:b60976a18a42150c85be2ac64ca329e21422c78b6c400ae045896fe716f47a09","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-2aab89b1fd6a","skills/forge-auto/SKILL.md","agent","excluded","sha256:2aab89b1fd6a42c5820a297bb9ca34377b44fe8cfed196a7739383846038015a","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-resolver-8d89dad85075","skills/forge-auto/SKILL.md","resolver","excluded","sha256:8d89dad850756ce5cb9aa8b77f7fb51f61b647a4d6b944dceec0f42b8a744dcc","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-resolver-8dbd5a1a07a0","skills/forge-auto/SKILL.md","resolver","excluded","sha256:8dbd5a1a07a002a2d078598837789f2c50e676ab8ee75febf354b86a1e7e9993","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-agent-68b2f6cc1ce6","skills/forge-auto/SKILL.md","agent","excluded","sha256:68b2f6cc1ce65d87721d03309a1fdb0fa4d4c1ace79c4d0a454829611f9f98c2","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-resolver-4da47647d4e3","skills/forge-auto/SKILL.md","resolver","excluded","sha256:4da47647d4e39fb248af293c523557e34e77cf68ed81669b4ec6dbad22ac1545","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-resolver-2c99832bb201","skills/forge-auto/SKILL.md","resolver","excluded","sha256:2c99832bb201f58fda8c14b3e87a0402dcd50b3e80bce9db4299539a9dae99fe","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-agent-25fcec2b19ab","skills/forge-auto/SKILL.md","agent","excluded","sha256:25fcec2b19abc1b9fe2b966aa68664bc89a814b1deb1677cc786e3d9f62b9edf","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-ede6a2d98900","skills/forge-auto/SKILL.md","agent","excluded","sha256:ede6a2d98900d3a03507de1518757cc8190899ede88b70501580e035d3cfb933","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-resolver-1508da51945a","skills/forge-auto/SKILL.md","resolver","excluded","sha256:1508da51945a5ec1aea50a45e714b17b1dd937512da05e03db648d53c2217688","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-resolver-80a11ff0b64d","skills/forge-auto/SKILL.md","resolver","excluded","sha256:80a11ff0b64d47e730c6430e834b1f221197b01a481fea850653cacee06660ea","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-agent-e3179ebc3152","skills/forge-auto/SKILL.md","agent","excluded","sha256:e3179ebc3152b0e954bf2be06eb364ed4f291fcea441fb65dc3dc200d8583831","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-resolver-678320af11ce","skills/forge-auto/SKILL.md","resolver","excluded","sha256:678320af11cecb63b4e31ffe8cf8229461908b5417fa020cf977ef991d2a41ac","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-agent-3252c71e933b","skills/forge-auto/SKILL.md","agent","excluded","sha256:3252c71e933ba38f27cb2459529b024df1ae6434593f14bcd51b6bce462507be","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-resolver-79b036c05706","skills/forge-auto/SKILL.md","resolver","excluded","sha256:79b036c05706f9d9400b462c36090ab795adff6bfffbac52516a90647bf03636","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-resolver-2626487d37ed","skills/forge-auto/SKILL.md","resolver","excluded","sha256:2626487d37ed2a43ec52813c1b0fa353425ca22e258a7531b3a8e47830c4b5b2","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-resolver-777c3ea47e6a","skills/forge-auto/SKILL.md","resolver","excluded","sha256:777c3ea47e6aade31694e0be55aa1dcffc54402d30a4ea67e99d3f3df9d4b793","filesystem path probe; it does not invoke the resolver",""],
  ["skills-forge-auto-skill-md-resolver-3f8a55208c08","skills/forge-auto/SKILL.md","resolver","operational","sha256:3f8a55208c0882b226d0c27df15ac5d67df4d9564d81dba06395d369d90c6963","","canonical"],
  ["skills-forge-auto-skill-md-resolver-e7acb7fb9232","skills/forge-auto/SKILL.md","resolver","excluded","sha256:e7acb7fb9232614221e280999693ef2b137dad185866c123423c88cc2160afd3","diagnostic text naming the resolver; it launches no process",""],
  ["skills-forge-auto-skill-md-resolver-457d6e4fb0f4","skills/forge-auto/SKILL.md","resolver","excluded","sha256:457d6e4fb0f44200ba4c2ea8fceb5d349786779bb52a4a1f49a3af339b6bcf47","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-auto-skill-md-agent-31cdc10886c5","skills/forge-auto/SKILL.md","agent","excluded","sha256:31cdc10886c5be8d62a1bf4da8d12f4cd2bb4d14130b091888cc734b0a868acd","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-resolver-b32eb4bf6884","skills/forge-auto/SKILL.md","resolver","operational","sha256:b32eb4bf6884b1d801fc7cc98d1eb9f0c362079d0709c4a0238720b4b16d1f04","","canonical"],
  ["skills-forge-auto-skill-md-resolver-ac140d7dfca5","skills/forge-auto/SKILL.md","resolver","excluded","sha256:ac140d7dfca5ca9a0bba8348b8e45edcde2454540a02ba7321ba6c0ab832b029","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-auto-skill-md-agent-c7eed1171094","skills/forge-auto/SKILL.md","agent","operational","sha256:c7eed1171094162634ed4abbb4ad70973174dc0e9c24384c34f22f769ebaa31a","",""],
  ["skills-forge-auto-skill-md-agent-b075961299dc","skills/forge-auto/SKILL.md","agent","operational","sha256:b075961299dc1f22d19ae51c84ce4f3417482cd2f25c75522e062e3e6fc4ace0","",""],
  ["skills-forge-auto-skill-md-resolver-004ac56d7556","skills/forge-auto/SKILL.md","resolver","operational","sha256:004ac56d7556597eab03512a24f1148ea2b2b9e2d86b4807f04cd9dceee0dc0e","","canonical"],
  ["skills-forge-auto-skill-md-resolver-d6e008adce05","skills/forge-auto/SKILL.md","resolver","excluded","sha256:d6e008adce051496188f21a3cc9da158a96f0c9714a0d17c3c70845a905ff71e","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-auto-skill-md-agent-8d34e4759f20","skills/forge-auto/SKILL.md","agent","excluded","sha256:8d34e4759f207e16f9ffb5c0fa821d01197d71c25781636ce3b1a15ce52802db","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-f43a21c4d4d1","skills/forge-auto/SKILL.md","agent","excluded","sha256:f43a21c4d4d1c173f51741dced4ddb8bfe30be32a400cf1d47532048307639bf","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-a8fb08e45b9f","skills/forge-auto/SKILL.md","agent","excluded","sha256:a8fb08e45b9fb6e4363d9b6f3d3d7cbd880793f40dc8155ce3e4cd8a1d62fde7","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-161a828476e4","skills/forge-auto/SKILL.md","agent","operational","sha256:161a828476e4e619fbe3cede892ee7484229893d0f55f93d3841e95272b306af","",""],
  ["skills-forge-auto-skill-md-agent-ed7b09e29a6f","skills/forge-auto/SKILL.md","agent","excluded","sha256:ed7b09e29a6f5e83c90addf1f6775bec93995e8140643a51f2bc25c4b3057031","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-982f796df502","skills/forge-auto/SKILL.md","agent","operational","sha256:982f796df502d8abc5eb18acbd6aaec559fc607888112239eeb8b5e6985628a0","",""],
  ["skills-forge-auto-skill-md-agent-f0bff0221588","skills/forge-auto/SKILL.md","agent","excluded","sha256:f0bff02215880216b4d3d63cb78cc26eabd71dd82150fd9396fe6a689489803f","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-cdb107786d8b","skills/forge-auto/SKILL.md","agent","excluded","sha256:cdb107786d8bf9e1be72d97cff92c24f026392e6cdf28c4a4ae55ddfc91b85c3","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-81bdf88ae1e0","skills/forge-auto/SKILL.md","agent","excluded","sha256:81bdf88ae1e09889e5e97a83c0d1861e3e768a882a6401700dd3d48f0846f1c5","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-7f5b33354627","skills/forge-auto/SKILL.md","agent","operational","sha256:7f5b333546274cd16ceaf5ab94d4df1f1d6fd421d1a32091c0fa0607f1f3d087","",""],
  ["skills-forge-auto-skill-md-agent-4a3c637c4f8c","skills/forge-auto/SKILL.md","agent","excluded","sha256:4a3c637c4f8c2254086d0eb9353a152309d6b9fb5ef564077691ad217ab8cbc5","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-resolver-61ba4f605908","skills/forge-auto/SKILL.md","resolver","excluded","sha256:61ba4f605908b3dcf5bc62efec7091f3724a2e64fa63414acad4062c310df139","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-auto-skill-md-agent-966ffe82d6d3","skills/forge-auto/SKILL.md","agent","operational","sha256:966ffe82d6d3e3ec1aded85ac96c8f7e9be5eab5be86b2e452880727e0ede3a1","",""],
  ["skills-forge-auto-skill-md-emitter-c4149483367f","skills/forge-auto/SKILL.md","emitter","operational","sha256:c4149483367f834a785e3a0fa8cd8214f8c5171a5bad10e3ba39a5b058d26509","",""],
  ["skills-forge-auto-skill-md-agent-bf5386e1ea1d","skills/forge-auto/SKILL.md","agent","excluded","sha256:bf5386e1ea1d3dc9e72806a0c8c12c4c5e30004e3727b334fa35db319116933e","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-fd51f1c271e1","skills/forge-auto/SKILL.md","agent","excluded","sha256:fd51f1c271e1f8821900bd72a4ac3db24da86323ea881776040766b801fe42f8","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-3b710f2f477c","skills/forge-auto/SKILL.md","agent","excluded","sha256:3b710f2f477cbd8152ca9e20c004401a56786dca917b22eee0d4c30f6eab2689","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-aaff68e2bfea","skills/forge-auto/SKILL.md","agent","excluded","sha256:aaff68e2bfea7e7c362fc45e5e61700de5e80237c06c6170083b78faaa6f84de","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-fe5f585df089","skills/forge-auto/SKILL.md","agent","excluded","sha256:fe5f585df089f3b20f923b14660f0aac0f33e53d28ba4faf06604b1e8339b547","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-9905bc07d3e5","skills/forge-auto/SKILL.md","agent","excluded","sha256:9905bc07d3e550021ecb6829771f42a6de3409c625886eba66a227a966b73c67","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-96d2bb25c273","skills/forge-auto/SKILL.md","agent","operational","sha256:96d2bb25c273135acc36a6637d77cec78c46ce2d0374d8185f46cc42bb10ea96","",""],
  ["skills-forge-auto-skill-md-agent-0af852022fef","skills/forge-auto/SKILL.md","agent","operational","sha256:0af852022fef3c99b417bb51de03da7cdf21b7a73ca27522456076a3f4a496bc","",""],
  ["skills-forge-auto-skill-md-agent-eccc879cedcd","skills/forge-auto/SKILL.md","agent","operational","sha256:eccc879cedcd86dd918c1ea8d331e1c59d721e96fa4d277ecead56861ed6d7a5","",""],
  ["skills-forge-auto-skill-md-agent-91ee75476dbc","skills/forge-auto/SKILL.md","agent","excluded","sha256:91ee75476dbce0668745340282042b10d6d28e5ea893c5f1463aa7632fc78bac","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-d4f748cde70e","skills/forge-auto/SKILL.md","agent","excluded","sha256:d4f748cde70ed8c55b87b29b4f16cfc6d9de60927fd9c83b5b82d606a40dbeb8","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-emitter-9b0c139427ac","skills/forge-auto/SKILL.md","emitter","operational","sha256:9b0c139427ac2d2e4784708599787e740325931bf164f2c39ea43ef5b669ab28","",""],
  ["skills-forge-auto-skill-md-agent-ab1f276f779c","skills/forge-auto/SKILL.md","agent","excluded","sha256:ab1f276f779caf086e8cf8ef279dbbc6c8ad29bb1b33a962f995fa977b48dee8","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-f947310b2264","skills/forge-auto/SKILL.md","agent","excluded","sha256:f947310b226499f37cc258d08cc209b2e44d9ccdeacd1335304e07ac47cf2baf","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-resolver-828278bda662","skills/forge-auto/SKILL.md","resolver","operational","sha256:828278bda662d013889b02c9ddf073e8e876b796b6027bcaf333830335212f03","","canonical"],
  ["skills-forge-auto-skill-md-resolver-8f47ef521bc8","skills/forge-auto/SKILL.md","resolver","excluded","sha256:8f47ef521bc8ddec4303f2164c72460cc27a9492c5cea5ac7a784529062e26b7","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-auto-skill-md-agent-201c2a787660","skills/forge-auto/SKILL.md","agent","excluded","sha256:201c2a787660d2bbe2fa659a6b5b8045d752f95cfdaef6c575592d7e5a711440","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-78e45ca2d37a","skills/forge-auto/SKILL.md","agent","excluded","sha256:78e45ca2d37a403959e27e736e17b132bf414727da389925a66257d705f8704a","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-52353ab043be","skills/forge-auto/SKILL.md","agent","operational","sha256:52353ab043be2205327cc14d6794bb51a3180ee28b9c6ede363c19f200af5936","",""],
  ["skills-forge-auto-skill-md-agent-aba5bbb91e40","skills/forge-auto/SKILL.md","agent","excluded","sha256:aba5bbb91e404cbde129798a5c12804d579b6b66ba57856ee2cd068663b9e2aa","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-642175993ad5","skills/forge-auto/SKILL.md","agent","excluded","sha256:642175993ad5f8c200d9dc77e7777875e7a3d01948bc84babbb0807153f0be4b","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-auto-skill-md-agent-db6bc7bf1268","skills/forge-auto/SKILL.md","agent","excluded","sha256:db6bc7bf1268a63ebcd42082fe032d95ef3bf1a121e94622e1136a60ce81dfc7","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-resolver-6ae913082333","skills/forge-next/SKILL.md","resolver","excluded","sha256:6ae913082333df10f7ba3c431a7ef2757a084636951812a00ca19b007a2eae5d","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-next-skill-md-resolver-6279e3632992","skills/forge-next/SKILL.md","resolver","excluded","sha256:6279e3632992187b31ba6128ae6f851c0ec9c5d0f55a14d97c6f88c7dd621094","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-next-skill-md-agent-eb57157d30d3","skills/forge-next/SKILL.md","agent","excluded","sha256:eb57157d30d3ea9f42f0f953fb8c889e0a95c42ea30b049801cef53611342cb9","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-resolver-c4dc8708f766","skills/forge-next/SKILL.md","resolver","excluded","sha256:c4dc8708f766e638392a6589c933b8271fa7679ab6d7e0685cee92dae923ed96","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-next-skill-md-resolver-5794d4fcbba4","skills/forge-next/SKILL.md","resolver","excluded","sha256:5794d4fcbba4c78d4de69e66a5372515485d81731f5fb020c0448944dcf8394a","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-next-skill-md-resolver-3b8ea8dd6411","skills/forge-next/SKILL.md","resolver","excluded","sha256:3b8ea8dd6411bd372f0beb7897a9a61dbfb1d7ec2faf26e9bc944b1b9dff21d5","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-next-skill-md-resolver-2626487d37ed","skills/forge-next/SKILL.md","resolver","excluded","sha256:2626487d37ed2a43ec52813c1b0fa353425ca22e258a7531b3a8e47830c4b5b2","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-next-skill-md-resolver-9e028f2bd907","skills/forge-next/SKILL.md","resolver","excluded","sha256:9e028f2bd90760bb0a8d64b4dd23a4c537477c4514c47179695914020f038651","filesystem path probe; it does not invoke the resolver",""],
  ["skills-forge-next-skill-md-resolver-dfba7b6b9661","skills/forge-next/SKILL.md","resolver","operational","sha256:dfba7b6b96611f38628e860f1411fe763d44d4d07d1f7582cd64fe0ab511e048","","canonical"],
  ["skills-forge-next-skill-md-resolver-f21aca5fc537","skills/forge-next/SKILL.md","resolver","excluded","sha256:f21aca5fc53703ff142f03bf578995405707009b8e070144d72911cc3760cd95","diagnostic text naming the resolver; it launches no process",""],
  ["skills-forge-next-skill-md-resolver-5c37e85afccf","skills/forge-next/SKILL.md","resolver","excluded","sha256:5c37e85afccfb994b739a48e60abe1478ac6ad8f3a71ef8653de8861b608c927","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-next-skill-md-agent-0e1ffac761e0","skills/forge-next/SKILL.md","agent","operational","sha256:0e1ffac761e01f01b511a14eae06d36f36065fc4dffd9a092ee7eddd61326f81","",""],
  ["skills-forge-next-skill-md-agent-ab7dff4fca01","skills/forge-next/SKILL.md","agent","operational","sha256:ab7dff4fca01aba4a7d616ece482108c6bb1d8afd83c7ac877b4f1d4b98a014b","",""],
  ["skills-forge-next-skill-md-resolver-db8e95b9f41d","skills/forge-next/SKILL.md","resolver","operational","sha256:db8e95b9f41d776958d00b4f6be532f84623f8d62992d62e4961d906b0e5e68c","","canonical"],
  ["skills-forge-next-skill-md-resolver-53f0a2da722a","skills/forge-next/SKILL.md","resolver","excluded","sha256:53f0a2da722a4dfa12cda4396fb059f6f8d31b442343b272b0d597e8f01435a3","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-next-skill-md-agent-999bfb809407","skills/forge-next/SKILL.md","agent","excluded","sha256:999bfb8094073085ea424a7e9cb74b91642d20ccd4d358dd87f5e5b66cb48b05","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-51077e27327d","skills/forge-next/SKILL.md","agent","excluded","sha256:51077e27327d96040919ef8b92030923c4a8176794dbf646d90d873b17b4de82","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-a8fb08e45b9f","skills/forge-next/SKILL.md","agent","excluded","sha256:a8fb08e45b9fb6e4363d9b6f3d3d7cbd880793f40dc8155ce3e4cd8a1d62fde7","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-ab81aa6b7768","skills/forge-next/SKILL.md","agent","operational","sha256:ab81aa6b77681ebb91102d91520ec5277ec6024f353e3023f3af43b65f5930c3","",""],
  ["skills-forge-next-skill-md-agent-ed7b09e29a6f","skills/forge-next/SKILL.md","agent","excluded","sha256:ed7b09e29a6f5e83c90addf1f6775bec93995e8140643a51f2bc25c4b3057031","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-ebdef6a35c1c","skills/forge-next/SKILL.md","agent","operational","sha256:ebdef6a35c1c24933d723ff771a582d99773e6458ef672ae4646bb70d7287466","",""],
  ["skills-forge-next-skill-md-agent-6c40f3ba04e9","skills/forge-next/SKILL.md","agent","excluded","sha256:6c40f3ba04e95c538a08593a405cc9b56468e179257d0d2544b1987df4e8daaf","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-94a818bb630f","skills/forge-next/SKILL.md","agent","excluded","sha256:94a818bb630fbb36bb9abe4fd59a41107199b307e1c813f5af7cba6546b5e732","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-783fe31e7855","skills/forge-next/SKILL.md","agent","operational","sha256:783fe31e785572fa64f05ddf669bc853d13021192ff367b02975847d85d7dc4f","",""],
  ["skills-forge-next-skill-md-agent-c88978c8bced","skills/forge-next/SKILL.md","agent","excluded","sha256:c88978c8bceddf8b05547efbc9a2e4ec38912049d849c1c695aefb769e7e26e4","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-83b527ba1f39","skills/forge-next/SKILL.md","agent","excluded","sha256:83b527ba1f39b7bb2bcb5f2c894ef41b8647fd851eaf52afc86e468434238b83","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-resolver-a607c005a017","skills/forge-next/SKILL.md","resolver","excluded","sha256:a607c005a01701a925aec7a5275ff01bab3661f96f9047c4be45e05bcc6ec5f1","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-next-skill-md-agent-cbf1cc453272","skills/forge-next/SKILL.md","agent","operational","sha256:cbf1cc453272b76edf4fc253561544eb464e0ea2ce15e92831e48b728a8fd0a5","",""],
  ["skills-forge-next-skill-md-emitter-bada9904c960","skills/forge-next/SKILL.md","emitter","operational","sha256:bada9904c9607abff56a7f458d542b1fe5f400924b4429795155430a095c9e48","",""],
  ["skills-forge-next-skill-md-agent-a9415582c739","skills/forge-next/SKILL.md","agent","excluded","sha256:a9415582c739067bcf9e0b779aab846768b6eceaf3163010cae139539d20cee6","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-740bc858dfbf","skills/forge-next/SKILL.md","agent","excluded","sha256:740bc858dfbf5a1210a721b1b98c6ed0de050e9a7ec3d606bf3b2d2dfa0020c9","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-8b9ec476d426","skills/forge-next/SKILL.md","agent","excluded","sha256:8b9ec476d4268b6a4fa9bfc359181dda46353b499d6f2e8ceea65ac68029f683","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-next-skill-md-agent-12bced4165f0","skills/forge-next/SKILL.md","agent","operational","sha256:12bced4165f06c305fd78bb84c1ed413e869f15b853ba73335a100e2384d2022","",""],
  ["skills-forge-next-skill-md-agent-6a41cefd5081","skills/forge-next/SKILL.md","agent","excluded","sha256:6a41cefd5081c94106574a8c460f90e87d812b7e7dbc5a1bcecdb6bb34ac6a8e","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-task-skill-md-resolver-8d2b47e59d6b","skills/forge-task/SKILL.md","resolver","excluded","sha256:8d2b47e59d6b3b46a2c66ba4c46f24cb704beecdcb3a334d3299e6d499e46bf8","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-task-skill-md-resolver-065fe8f6ffbd","skills/forge-task/SKILL.md","resolver","excluded","sha256:065fe8f6ffbd3a09dbba2368b4cb14f405c7e55f143cd09ebc3bb2337cffe120","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-task-skill-md-resolver-33f42b91e15b","skills/forge-task/SKILL.md","resolver","excluded","sha256:33f42b91e15bdcd55acd368cf3fe452c1af7e694818510e6facded080a07e993","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-task-skill-md-resolver-654f83c0ffe8","skills/forge-task/SKILL.md","resolver","excluded","sha256:654f83c0ffe83141738f84ee034e1901393372a34fd1e35dce0fb53ac90c739f","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-task-skill-md-resolver-c8098b0236d9","skills/forge-task/SKILL.md","resolver","excluded","sha256:c8098b0236d941cf960571e826d1e56b016250cff3e3e64fcdccd4d3adf94405","filesystem path probe; it does not invoke the resolver",""],
  ["skills-forge-task-skill-md-resolver-8da51052b803","skills/forge-task/SKILL.md","resolver","operational","sha256:8da51052b8033c3f020c2e3e4370e38b14233efca85155caf81c61a02149d5c5","","canonical"],
  ["skills-forge-task-skill-md-resolver-b24e4ef1deb2","skills/forge-task/SKILL.md","resolver","excluded","sha256:b24e4ef1deb293bee833c37a08f5001c9b16aa32f54ab14d0fc35fcc5c378f17","diagnostic text naming the resolver; it launches no process",""],
  ["skills-forge-task-skill-md-resolver-72427970217c","skills/forge-task/SKILL.md","resolver","excluded","sha256:72427970217cf1c3e70cc6bec14ae84cd33f33cedff9844dbd81a92d2d435ddb","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-task-skill-md-resolver-7f0fb7952ab3","skills/forge-task/SKILL.md","resolver","excluded","sha256:7f0fb7952ab334924beb13a81c5ab490faeec4066975e4908d18ca9c214d494a","documentation or explanatory resolver reference; it launches no process",""],
  ["skills-forge-task-skill-md-agent-ff5b9b8404e5","skills/forge-task/SKILL.md","agent","excluded","sha256:ff5b9b8404e5019cbd2f9607d2fbccd9361e9f78f941ddd849890c5d9af0bd39","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-task-skill-md-agent-97ff7812190c","skills/forge-task/SKILL.md","agent","excluded","sha256:97ff7812190c5f551045cbe007b79a1b4a75b63d4f4a5e984e9941262a323030","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-task-skill-md-adapter-f3bfa7a9562d","skills/forge-task/SKILL.md","adapter","operational","sha256:f3bfa7a9562d44d045abaf98e8f602dfc58a7d6c3823c4fde9de3065f27b9cf2","",""],
  ["skills-forge-task-skill-md-emitter-9d3f3d4adce5","skills/forge-task/SKILL.md","emitter","operational","sha256:9d3f3d4adce58d10969a8351c283e813dec00c42f5a9e2a20ca304b670bd071b","",""],
  ["skills-forge-task-skill-md-agent-86f259014c13","skills/forge-task/SKILL.md","agent","excluded","sha256:86f259014c1352f933303c36538b2a439b219b884d895a5116724273feba1c95","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-task-skill-md-agent-31fee1f6421a","skills/forge-task/SKILL.md","agent","operational","sha256:31fee1f6421ad996358abd565b0296581e3932b91bcd96df277b82abf349b49c","",""],
  ["skills-forge-task-skill-md-agent-4862247d599e","skills/forge-task/SKILL.md","agent","excluded","sha256:4862247d599edb85882dc9f209aa0ae9037455cccd15bc8c7c446000f2b0e96a","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-task-skill-md-agent-a7f56cf4aa9c","skills/forge-task/SKILL.md","agent","excluded","sha256:a7f56cf4aa9caa265a2cdc04da096bc9d41233d00801a0e5b4747e64b01f400f","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-task-skill-md-emitter-7dc46066bf23","skills/forge-task/SKILL.md","emitter","operational","sha256:7dc46066bf234da6b30b6198466704f1193b86883506a2f7cd876a69081f96b4","",""],
  ["skills-forge-task-skill-md-agent-3c945bfefc43","skills/forge-task/SKILL.md","agent","operational","sha256:3c945bfefc4386831f2128411f0026dca517036d07d415c3c3d9c7ca477bb1c8","",""],
  ["skills-forge-task-skill-md-agent-a531ba0fd109","skills/forge-task/SKILL.md","agent","operational","sha256:a531ba0fd109c9287bf7dd850210ceb3ee6694d0dfdea97514b37f9b69cc1da9","",""],
  ["skills-forge-task-skill-md-resolver-37b4afdd65a7","skills/forge-task/SKILL.md","resolver","operational","sha256:37b4afdd65a79537272e0ccbb4421e0d9aa6a1529eb4685eb7601dfde70e9121","","canonical"],
  ["skills-forge-task-skill-md-resolver-5997cdaa2bb9","skills/forge-task/SKILL.md","resolver","excluded","sha256:5997cdaa2bb91444a584bfd0f25c628aa8088c21186106e1b0d7474c885106f0","shell-exports parser invocation; it consumes JSON and does not resolve a host",""],
  ["skills-forge-task-skill-md-agent-42a759588ffb","skills/forge-task/SKILL.md","agent","operational","sha256:42a759588ffba66f7a4d1694d8affcd5099a8807b9dec17d3a044d659d9eede6","",""],
  ["skills-forge-task-skill-md-emitter-7806bea0df54","skills/forge-task/SKILL.md","emitter","operational","sha256:7806bea0df545f3135850bb289405459339c30abebcaef6d1ae6d126ee94f7ea","",""],
  ["skills-forge-task-skill-md-agent-7181e2fd54f6","skills/forge-task/SKILL.md","agent","excluded","sha256:7181e2fd54f65ea917aee1301c1bcf7351086008c16c18459e014f7d028e07c5","projected explanatory Agent prose; it is not a worker invocation",""],
  ["skills-forge-task-skill-md-agent-ed8da7be87c8","skills/forge-task/SKILL.md","agent","operational","sha256:ed8da7be87c8993ac7f01a9d80180b1b067a8c3622e7f9e5e37a2107fba8be8a","",""],
];

const SOURCE_REGISTRY = deepFreeze(REGISTRY_ROWS.map((row) => ({
  id: row[0],
  path: row[1],
  kind: row[2],
  classification: row[3],
  fingerprint: row[4],
  reason: row[5],
  host_policy: row[6] || '',
})));

function normalizedLine(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}

function nearestAnchor(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const line = normalizedLine(lines[cursor]);
    if (/^#{1,6}\s+\S/.test(line) || /^\*\*[^*].*\*\*(?:\s|$)/.test(line)) return line;
  }
  return '<document-root>';
}

function followingAnchor(lines, index) {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = normalizedLine(lines[cursor]);
    if (/^#{1,6}\s+\S/.test(line) || /^\*\*[^*].*\*\*(?:\s|$)/.test(line)) return line;
  }
  return '<boundary>';
}

function evidenceText(kind, lines, index) {
  const window = [];
  for (let cursor = Math.max(0, index - 3); cursor <= Math.min(lines.length - 1, index + 3); cursor += 1) {
    window.push(normalizedLine(lines[cursor]) || '<blank>');
  }
  return [kind, nearestAnchor(lines, index), ...window, followingAnchor(lines, index)].join('\n');
}

function fingerprint(kind, lines, index) {
  const digest = crypto.createHash('sha256').update(evidenceText(kind, lines, index), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function scanRealMarkers(text) {
  const lines = String(text).split('\n');
  const starts = [];
  const ends = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    if (fence) {
      const match = new RegExp(`^${fence.char}{${fence.length},}[ \\t]*$`).exec(line);
      if (match) fence = null;
      continue;
    }
    const opening = /^(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
      continue;
    }
    if (line === MARKER_START) starts.push(index);
    if (line === MARKER_END) ends.push(index);
  }
  return { starts, ends };
}

function markerState(text) {
  const markers = scanRealMarkers(text);
  if (markers.starts.length === 0 && markers.ends.length === 0) return { pair: null, errors: [] };
  const errors = [];
  if (markers.starts.length !== 1) errors.push(`expected one real start marker, found ${markers.starts.length}`);
  if (markers.ends.length !== 1) errors.push(`expected one real end marker, found ${markers.ends.length}`);
  if (errors.length === 0 && markers.starts[0] >= markers.ends[0]) errors.push('dispatch end marker does not follow start');
  return {
    pair: errors.length === 0 ? { start: markers.starts[0], end: markers.ends[0] } : null,
    errors,
  };
}

function commandContext(lines, index) {
  let start = index;
  if (/\$\{XLLM_ARGS\[@\]\}/.test(lines[index])) {
    for (let cursor = index - 1; cursor >= Math.max(0, index - 30); cursor -= 1) {
      if (/XLLM_ARGS=\(/.test(lines[cursor])) { start = cursor; break; }
      if (/^```/.test(lines[cursor].trim())) break;
    }
  }
  while (start > 0 && index - start < 3) {
    const previous = lines[start - 1];
    if (!previous.trim() || /^```/.test(previous.trim())) break;
    if (/\\\s*$/.test(previous) || /(?:ARGV|ARGS)=\(/.test(previous)) start -= 1;
    else break;
  }
  let end = index;
  while (end + 1 < lines.length && end - index < 14) {
    const current = lines[end];
    const next = lines[end + 1];
    if (/^```/.test(next.trim())) break;
    if (/\\\s*$/.test(current) || /(?:ARGV|ARGS)=\([\s\S]*$/.test(lines[start]) ||
        (/^\s+--/.test(next) && !next.includes('```')) ||
        (/^\s+(?:"?\$|>>)/.test(next) && lines[start].includes('printf'))) {
      end += 1;
      if (/\)\s*$/.test(next) && !/\\\s*$/.test(next)) break;
      continue;
    }
    break;
  }
  return lines.slice(start, end + 1).join('\n');
}

function candidate(pathName, kind, lines, lineIndex, column) {
  return {
    path: pathName,
    kind,
    fingerprint: fingerprint(kind, lines, lineIndex),
    line: lineIndex + 1,
    column: column + 1,
    evidence: normalizedLine(lines[lineIndex]),
    context: commandContext(lines, lineIndex),
  };
}

function tokenCandidates(pathName, kind, lines) {
  const found = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const expression = new RegExp(TOKEN[kind].source, 'g');
    const match = expression.exec(lines[lineIndex]);
    if (match) found.push(candidate(pathName, kind, lines, lineIndex, match.index));
  }
  return found;
}

function emitterCandidates(pathName, lines) {
  const found = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const dispatchValue = /(?:\\?"event\\?"\s*:\s*\\?"dispatch\\?"|event\s*:\s*['"]dispatch['"])/.test(line);
    const shellWriter = /\b(?:echo|printf)\b/.test(line);
    if (dispatchValue && shellWriter) found.push(candidate(pathName, 'emitter', lines, lineIndex, line.search(/dispatch/)));
  }
  return found;
}

function discover(root) {
  const base = path.resolve(root || path.join(__dirname, '..'));
  const found = [];
  const documents = new Map();
  for (const relative of SCOPED_FILES) {
    const absolute = path.join(base, relative);
    const text = fs.readFileSync(absolute, 'utf8');
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    documents.set(relative, { text, lines, markers: markerState(text) });
    found.push(...tokenCandidates(relative, 'resolver', lines));
    if (AGENT_FILES.has(relative)) found.push(...tokenCandidates(relative, 'agent', lines));
    if (ADAPTER_FILES.has(relative)) found.push(...tokenCandidates(relative, 'adapter', lines));
    found.push(...emitterCandidates(relative, lines));
  }
  found.sort((left, right) => (
    left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column || left.kind.localeCompare(right.kind)
  ));
  return { root: base, candidates: found, documents };
}

function identity(value) {
  return `${value.path}\u0000${value.kind}\u0000${value.fingerprint}`;
}

function duplicates(values, keyOf) {
  const seen = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(value);
  }
  return [...seen.entries()].filter((entry) => entry[1].length > 1).map(([key, entries]) => ({ key, entries }));
}

function inside(pair, lineIndex) {
  return Boolean(pair && lineIndex > pair.start && lineIndex < pair.end);
}

function structuralErrors(entry, discovered, document) {
  if (entry.classification !== 'operational') return [];
  const errors = [];
  const location = `${entry.path}:${discovered.line}`;
  const projected = PROJECTED_SKILLS.includes(entry.path);
  if (entry.kind === 'resolver') {
    if (entry.host_policy === 'canonical' && !/--host-runtime\s+claude\b/.test(discovered.context)) {
      errors.push(`${location} operational resolver lacks canonical --host-runtime claude`);
    }
    if (entry.host_policy === 'inherited' && !/--host-runtime\s+"?\$HOST_RUNTIME"?/.test(discovered.context)) {
      errors.push(`${location} inherited resolver lacks a real HOST_RUNTIME argument`);
    }
    if (projected && !inside(document.markers.pair, discovered.line - 1)) {
      errors.push(`${location} projected resolver lies outside the real dispatch markers`);
    }
  }
  if (entry.kind === 'agent' && projected && !inside(document.markers.pair, discovered.line - 1)) {
    errors.push(`${location} operational Agent( lies outside the real dispatch markers`);
  }
  if (entry.kind === 'adapter') {
    if (!/--host-runtime\s+(?:"?\$HOST_RUNTIME"?|claude|codex)\b/.test(discovered.context)) {
      errors.push(`${location} sidecar adapter lacks a real --host-runtime argument`);
    }
    if (!/--sidecar-declared\b/.test(discovered.context)) {
      errors.push(`${location} sidecar adapter lacks --sidecar-declared`);
    }
  }
  if (entry.kind === 'emitter') {
    for (const field of ['host_runtime', 'worker_mode', 'dispatch_allowed']) {
      if (!new RegExp(`(?:\\\\?"${field}\\\\?"|${field})\\s*:`).test(discovered.context)) {
        errors.push(`${location} dispatch emitter lacks ${field}`);
      }
    }
    if (/(?:\\?"dispatch_allowed\\?"\s*:\s*\\?"|"dispatch_allowed"\s*:\s*")/.test(discovered.context)) {
      errors.push(`${location} dispatch_allowed is JSON-quoted instead of boolean`);
    }
  }
  return errors;
}

function publicCandidate(value) {
  return {
    path: value.path,
    kind: value.kind,
    fingerprint: value.fingerprint,
    line: value.line,
    evidence: value.evidence,
  };
}

function audit(options = {}) {
  const registry = options.registry || SOURCE_REGISTRY;
  const measured = discover(options.root);
  const discoveredByIdentity = new Map(measured.candidates.map((item) => [identity(item), item]));
  const registeredByIdentity = new Map(registry.map((item) => [identity(item), item]));
  const duplicateIds = duplicates(registry, (item) => item.id);
  const duplicateRegistered = duplicates(registry, identity);
  const duplicateDiscovered = duplicates(measured.candidates, identity);
  const unexpected = measured.candidates.filter((item) => !registeredByIdentity.has(identity(item))).map(publicCandidate);
  const missing = registry.filter((item) => !discoveredByIdentity.has(identity(item))).map((item) => ({
    id: item.id, path: item.path, kind: item.kind, fingerprint: item.fingerprint,
  }));
  const errors = [];

  for (const duplicate of duplicateIds) errors.push(`duplicate registry identifier: ${duplicate.key}`);
  for (const duplicate of duplicateRegistered) errors.push(`duplicate registered candidate: ${duplicate.key}`);
  for (const duplicate of duplicateDiscovered) errors.push(`duplicate discovered candidate: ${duplicate.key}`);
  for (const item of registry) {
    if (!['operational', 'excluded'].includes(item.classification)) errors.push(`${item.id}: invalid classification`);
    if (item.classification === 'excluded' && (!item.reason || !item.reason.trim())) errors.push(`${item.id}: exclusion reason is empty`);
    if (item.classification === 'operational' && item.reason) errors.push(`${item.id}: operational entry must not carry an exclusion reason`);
    if (item.kind === 'resolver' && item.classification === 'operational' &&
        !['canonical', 'inherited'].includes(item.host_policy)) {
      errors.push(`${item.id}: operational resolver lacks a host policy`);
    }
  }
  for (const relative of PROJECTED_SKILLS) {
    for (const markerError of measured.documents.get(relative).markers.errors) errors.push(`${relative}: ${markerError}`);
  }
  for (const entry of registry) {
    const found = discoveredByIdentity.get(identity(entry));
    if (found) errors.push(...structuralErrors(entry, found, measured.documents.get(entry.path)));
  }

  const ok = unexpected.length === 0 && missing.length === 0 && errors.length === 0;
  return {
    ok,
    root: measured.root,
    discovered_count: measured.candidates.length,
    registered_count: registry.length,
    unexpected,
    missing,
    errors,
  };
}

function main(argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr) {
  const root = argv[0] ? path.resolve(argv[0]) : path.resolve(__dirname, '..');
  try {
    const report = audit({ root });
    output.write(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    return 2;
  }
}

module.exports = {
  PROJECTED_SKILLS,
  SHARED_SPECS,
  SCOPED_FILES,
  SOURCE_REGISTRY,
  deepFreeze,
  normalizedLine,
  scanRealMarkers,
  markerState,
  discover,
  identity,
  audit,
  main,
};

if (require.main === module) process.exitCode = main();
