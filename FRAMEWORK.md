
# Framework Usage

Work in progress - documentation for using the core framework to author compositions in TypeScript. This is a higher-level overview; see the source code and tests for more details and examples.

### Install in Your Project (for development)

Add xplane packages to your TypeScript project:

```bash
npm install @xplane/core
# or
pnpm add @xplane/core
```

### Generate Types

```bash
# From CRDs
npx @xplane/codegen generate-from crd \
  --uri https://doc.crds.dev/raw/github.com/kubernetes-sigs/karpenter@v1.5.0 \
  --output-dir src/generated

# From Crossplane CompositeResourceDefinitions (XRDs)
npx @xplane/codegen generate-from xrd \
  --uri ./path/to/xrd.yaml \
  --output-dir src/generated

# From Kubernetes core API schema version
npx @xplane/codegen generate-from k8s \
  --k8s-version v1.31.0 \
  --output-dir src/generated

# From a Crossplane provider OCI package
npx @xplane/codegen generate-from xpkg \
  --oci xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0 \
  --groups ec2.aws.upbound.io \
  --output-dir src/generated
```