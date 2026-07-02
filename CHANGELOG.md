## 1.9.1 (2026-07-02)

### 🩹 Fixes

- **function:** force XR ready=false while blocked resources wait ([e404bbc](https://github.com/sv-oss/xplane/commit/e404bbc))

### ❤️ Thank You

- Matteo Sessa

## 1.9.0 (2026-07-02)

### 🚀 Features

- **codegen:** add allow-extra-objects flag to helm chart codegen ([#32](https://github.com/sv-oss/xplane/pull/32))

### ❤️ Thank You

- Chris Gatt @cgatt

## 1.8.0 (2026-07-02)

### 🚀 Features

- **core:** emit Crossplane Usage/ClusterUsage docs from dependency edges ([#31](https://github.com/sv-oss/xplane/pull/31))

### ❤️ Thank You

- Matteo Sessa

## 1.7.1 (2026-06-30)

### 🩹 Fixes

- **codegen:** fix citty conflict with no-barrel flag ([#30](https://github.com/sv-oss/xplane/pull/30))

### ❤️ Thank You

- Chris Gatt @cgatt

## 1.7.0 (2026-06-23)

### 🚀 Features

- **codegen:** support setting chart-name for generate-helm-from ([58c6f07](https://github.com/sv-oss/xplane/commit/58c6f07))

### ❤️ Thank You

- Matteo Sessa

## 1.6.1 (2026-06-22)

### 🚀 Features

- **cli:** drop dependency on crane ([#29](https://github.com/sv-oss/xplane/pull/29))

### ❤️ Thank You

- Matteo Sessa

## 1.6.0 (2026-06-22)

### 🚀 Features

- **function:** add new OCI loader ([#28](https://github.com/sv-oss/xplane/pull/28))

### ❤️ Thank You

- Matteo Sessa

## 1.5.1 (2026-06-22)

### 🩹 Fixes

- ensure explicit dependencies are always considered in the sequencing ([4f2d621](https://github.com/sv-oss/xplane/commit/4f2d621))

### ❤️ Thank You

- Matteo Sessa

## 1.5.0 (2026-06-21)

### 🚀 Features

- **utils:** improve API ([0348ef9](https://github.com/sv-oss/xplane/commit/0348ef9))

### ❤️ Thank You

- Matteo Sessa

## 1.4.0 (2026-06-21)

### 🚀 Features

- support for explicit dependencies in compositions ([#27](https://github.com/sv-oss/xplane/pull/27))

### 🩹 Fixes

- release utils package ([b33a529](https://github.com/sv-oss/xplane/commit/b33a529))

### ❤️ Thank You

- Matteo Sessa

## 1.3.0 (2026-06-21)

### 🚀 Features

- add Helm chart generation and new utils package ([#26](https://github.com/sv-oss/xplane/pull/26))

### ❤️ Thank You

- Matteo Sessa

## 1.2.0 (2026-06-20)

### 🚀 Features

- **core:** optional emitXplaneStatus flag in composition ([d829bff](https://github.com/sv-oss/xplane/commit/d829bff))

### 🩹 Fixes

- **codegen:** declare extraSchema fields on the class body for TypeScript generation ([2e1bc79](https://github.com/sv-oss/xplane/commit/2e1bc79))
- **core:** patch node.host to ensure correct proxy behavior in Resource class ([aaaa3fb](https://github.com/sv-oss/xplane/commit/aaaa3fb))
- **core:** add error handling and logging in CompositionHandler's RunFunction method ([999be5b](https://github.com/sv-oss/xplane/commit/999be5b))
- **core:** pre-hydrate composed resources during construction ([543b52d](https://github.com/sv-oss/xplane/commit/543b52d))
- **function:** include source maps ([f182846](https://github.com/sv-oss/xplane/commit/f182846))
- **pipeline:** preserve blocked resources with observed state to prevent deletion ([3b0fe4c](https://github.com/sv-oss/xplane/commit/3b0fe4c))
- **pipeline:** strip server-managed fields from preserved observed documents ([db73d18](https://github.com/sv-oss/xplane/commit/db73d18))

### ❤️ Thank You

- Matteo Sessa

## 1.1.0 (2026-05-29)

### 🚀 Features

- **core:** resolve template literals with pending values via Token Registry ([91d645f](https://github.com/sv-oss/xplane/commit/91d645f))
- **core:** add uniqueNameRfc1123 method for RFC 1123 compliant resource naming ([ca35616](https://github.com/sv-oss/xplane/commit/ca35616))

### 🩹 Fixes

- **function:** prevent premature XR readiness when resources are blocked ([8e65692](https://github.com/sv-oss/xplane/commit/8e65692))

### ❤️ Thank You

- Matteo Sessa

## 1.0.1 (2026-05-28)

### 🩹 Fixes

- **codegen:** correct optional property determination in generateProperties and generateInlineObject ([bebed7a](https://github.com/sv-oss/xplane/commit/bebed7a))
- **core:** implement lazy initialization proxy for nested properties in Resource ([de2f2bf](https://github.com/sv-oss/xplane/commit/de2f2bf))
- **core:** enhance createWriteProxy to support fallback reads from observed state ([3842005](https://github.com/sv-oss/xplane/commit/3842005))
- **devtools:** simulator should defer composition instantiation until requiredResources is populated ([5a14c51](https://github.com/sv-oss/xplane/commit/5a14c51))

### ❤️ Thank You

- Matteo Sessa

# 1.0.0 (2026-05-21)

### 🚀 Features

- ⚠️  refactor ([#25](https://github.com/sv-oss/xplane/pull/25))

### ⚠️  Breaking Changes

- refactor  ([#25](https://github.com/sv-oss/xplane/pull/25))

### ❤️ Thank You

- Matteo Sessa

## 0.16.0 (2026-05-19)

### 🚀 Features

- support full bundling of composition code ([4707941](https://github.com/sv-oss/xplane/commit/4707941))

### ❤️ Thank You

- Matteo Sessa

## 0.15.2 (2026-05-18)

### 🩹 Fixes

- resolve shared proxy refs and array path notation in sequencing ([b2d94f2](https://github.com/sv-oss/xplane/commit/b2d94f2))

### ❤️ Thank You

- Matteo Sessa

## 0.15.1 (2026-05-18)

### 🩹 Fixes

- **core:** add deepCloneWithTracked to preserve shared object references in Resource ([694c557](https://github.com/sv-oss/xplane/commit/694c557))

### ❤️ Thank You

- Matteo Sessa

## 0.15.0 (2026-05-18)

### 🚀 Features

- **core:** enhance createTrackedProxy with strict mode for optional chaining support ([e17fa06](https://github.com/sv-oss/xplane/commit/e17fa06))

### ❤️ Thank You

- Matteo Sessa

## 0.14.0 (2026-05-18)

### 🚀 Features

- **codegen:** support generating types from xrds ([d26943c](https://github.com/sv-oss/xplane/commit/d26943c))
- **core:** add Resource.fromExistingByName() to read existing cluster resources ([59889cd](https://github.com/sv-oss/xplane/commit/59889cd))

### 🩹 Fixes

- **codegen:** export interfaces as type ([063e651](https://github.com/sv-oss/xplane/commit/063e651))

### ❤️ Thank You

- Matteo Sessa

## 0.13.0 (2026-05-18)

### 🚀 Features

- **codegen:** emit fully-qualified internal names with short-name export block ([6e6c7eb](https://github.com/sv-oss/xplane/commit/6e6c7eb))

### ❤️ Thank You

- Matteo Sessa

## 0.12.0 (2026-05-18)

### 🚀 Features

- **codegen:** emit jsdoc for all properties ([417106b](https://github.com/sv-oss/xplane/commit/417106b))

### ❤️ Thank You

- Matteo Sessa

## 0.11.0 (2026-05-17)

### 🚀 Features

- **codegen:** add cli flags to help disambiguate class names ([531e058](https://github.com/sv-oss/xplane/commit/531e058))

### 🏡 Chore

- fix ghcr publishing ([4aeb4c6](https://github.com/sv-oss/xplane/commit/4aeb4c6))
- fix ghcr publishing ([e7a094e](https://github.com/sv-oss/xplane/commit/e7a094e))
- fix ghcr publishing ([1fd9ebb](https://github.com/sv-oss/xplane/commit/1fd9ebb))

### ❤️ Thank You

- Matteo Sessa

## 0.10.0 (2026-05-17)

### 🚀 Features

- automatic xpkg publishing ([#24](https://github.com/sv-oss/xplane/pull/24))

### ❤️ Thank You

- Matteo Sessa

## 0.9.2 (2026-05-17)

### 🏡 Chore

- **deps:** update npm dependencies ([#22](https://github.com/sv-oss/xplane/pull/22))

## 0.9.1 (2026-05-16)

### 🩹 Fixes

- **devtools:** preserve the assertions namespace ([684c0d3](https://github.com/sv-oss/xplane/commit/684c0d3))

### ❤️ Thank You

- Matteo Sessa

## 0.9.0 (2026-05-16)

### 🚀 Features

- testing framework for compositions ([#20](https://github.com/sv-oss/xplane/pull/20))

### ❤️ Thank You

- Matteo Sessa

## 0.8.0 (2026-05-16)

### 🚀 Features

- **function:** add support for git loader ([1ccd5a6](https://github.com/sv-oss/xplane/commit/1ccd5a6))

### ❤️ Thank You

- Matteo Sessa

## 0.7.4 (2026-05-16)

### 🏡 Chore

- prepare for release ([94fda8a](https://github.com/sv-oss/xplane/commit/94fda8a))

### ❤️ Thank You

- Matteo Sessa

## 0.7.3 (2026-05-16)

### 🏡 Chore

- prepare for release ([1b74023](https://github.com/sv-oss/xplane/commit/1b74023))

### ❤️ Thank You

- Matteo Sessa

## 0.7.2 (2026-05-16)

### 🏡 Chore

- prepare for release ([ff1362a](https://github.com/sv-oss/xplane/commit/ff1362a))
- prepare for release ([8d7969f](https://github.com/sv-oss/xplane/commit/8d7969f))

### ❤️ Thank You

- Matteo Sessa

## 0.7.1 (2026-05-16)

### 🏡 Chore

- prepare for release ([975d18e](https://github.com/sv-oss/xplane/commit/975d18e))

### ❤️ Thank You

- Matteo Sessa