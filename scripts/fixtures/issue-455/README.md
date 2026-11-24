# Additive measured distribution — issue #455

Predecessor: issues-451-452 at the exact integrated commit 18db6e64aa3f62ad3f94b9747f8aec5d5fad3675.

This layer measures 5 accepted source paths and 29 discovered top-level consumers: 24 require-only migrations and 5 explicit historical-test adapters (451/452, 440 and three CHANGELOG readers). Existing and new source files are both censused; unknown bytes are not rewound. All 218 published fixture files remain unchanged.

Each public validator delegates through the complete predecessor once. Historical tests retain their own worlds and negative assertions. Exact current smoke text is rewound through its measured preimage before predecessor smoke delegation; baseline/foreign text is delegated unchanged. The new layer CJS, delta and focused test are outside their own measurement to avoid a hash cycle; this README is a measured new file. No behavior/CI/release result is anticipated here.
