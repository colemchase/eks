# ESO, ECR, and Argo CD reference code

These files are small, copyable references for the EKS Pod Identity, ESO, ECR,
and Argo CD integration. They intentionally separate the two ECR paths:

```text
Node role -> pulls workload container images
ESO Pod Identity -> creates Argo CD's OCI Helm-chart credential
```

## Current deployed pattern: shared Build reader role

Apply the pieces in this order:

1. [`current-shared-build-reader.ts`](current-shared-build-reader.ts) creates
   the per-cluster ESO Pod Identity role and grants it permission to assume the
   shared Build reader role.
2. [`current-ecr-chart-credentials.yaml`](current-ecr-chart-credentials.yaml)
   creates the ESO ECR token generator and the Argo CD repository Secret.
3. [`node-image-pull-role.ts`](node-image-pull-role.ts) creates the separate
   EC2 node role used to pull workload container images.
4. [`github-app-repository.yaml`](github-app-repository.yaml) shows the
   independent GitHub App credential path Argo CD uses to read Git repositories.

This is the pattern currently deployed in `work`.

## Optional variant: direct per-cluster ECR reader

Use this only when Build ECR repository policies already grant access to the
environment account:

1. Add the identity permissions from
   [`per-cluster-ecr-reader.ts`](per-cluster-ecr-reader.ts) to the ESO role.
2. Use [`per-cluster-ecr-token-generator.yaml`](per-cluster-ecr-token-generator.yaml)
   instead of the shared-reader generator. It deliberately omits `spec.role`.
3. Keep the same `ExternalSecret` repository-Secret template.

This variant does not use an IAM OIDC provider or IRSA. ESO still receives its
AWS credentials through the EKS Pod Identity association.

## Values to replace

Replace these placeholders in the YAML examples:

- `REPLACE_WITH_REGION`
- `REPLACE_WITH_BUILD_ACCOUNT_ID`
- `REPLACE_WITH_BUILD_HELM_READER_ROLE_ARN`
- `REPLACE_WITH_BUILD_GITHUB_SECRET_READER_ROLE_ARN`
- `REPLACE_WITH_GITHUB_APP_ID`
- `REPLACE_WITH_GITHUB_APP_INSTALLATION_ID`

Do not place actual private keys, ECR authorization tokens, or Cognito client
secrets in Git. ESO reads source secrets and writes the Kubernetes Secrets.
