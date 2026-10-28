# ESO, ECR, and Argo CD authentication

Argo CD reads OCI Helm charts from the Build account's Amazon ECR registry. It
does not receive AWS credentials or EKS Pod Identity directly. External Secrets
Operator (ESO) obtains and refreshes the ECR credential, then writes a standard
Argo CD repository Secret.

```text
EKS Pod Identity Agent
  -> external-secrets ServiceAccount
  -> environment external-secrets IAM role
  -> Build build-helm-chart-reader role
  -> ECR authorization token
  -> ESO-managed Argo CD repository Secret
  -> Argo CD repo server reads OCI Helm charts
```

## Explicit authentication boundaries

There are three distinct authentication systems here. They must not be
confused with one another.

| Step | Component | Credential mechanism | IAM OIDC provider / IRSA? |
|---|---|---|---|
| 1 | ESO pod receives AWS credentials | EKS Pod Identity Agent plus an EKS Pod Identity association | **No.** No IAM OIDC provider is registered and no IRSA annotation is used. |
| 2 | ESO reads AWS secrets or requests an ECR token | The cluster-specific ESO IAM role, optionally assuming a Build role | **No.** This is IAM and STS authorization. |
| 3 | ESO writes the Argo repository credential | Kubernetes Secret created by ESO | **No.** The Secret contains generated ECR basic-auth data. |
| 4 | Argo CD repo server pulls OCI Helm charts | Kubernetes repository Secret: ECR username and token | **No.** Argo does not receive Pod Identity credentials for this pull. |
| 5 | Kubernetes node pulls workload images | EC2 instance-profile credentials on the bootstrap or Karpenter node role | **No.** This is node IAM, not pod IAM. |
| 6 | A human signs into Argo CD | Cognito OIDC | Separate concern; it is user login, not AWS workload authentication. |

The EKS cluster can expose an OIDC issuer URL, but this design does not
register it as an IAM OIDC provider. There is no `AWS::IAM::OIDCProvider`, no
`aws_iam_openid_connect_provider`, and no
`eks.amazonaws.com/role-arn` ServiceAccount annotation.

## Pod Identity

The EKS cluster construct creates an EKS Pod Identity association for:

```text
namespace:       external-secrets
service account: external-secrets
IAM role:        <environment>-<region>-eks-external-secrets
```

The EKS Pod Identity Agent supplies AWS credentials for that IAM role only to
the ESO controller pods using the `external-secrets` ServiceAccount.

**Explicitly:** the Pod Identity Agent obtains credentials through the EKS Pod
Identity service. It does not exchange a Kubernetes ServiceAccount token with
an IAM OIDC provider, which is how IRSA works.

The environment ESO role has permission to assume the Build account's
`build-helm-chart-reader` role. The Build role is the cross-account boundary
that grants the ECR read/token permissions.

## Current implementation reference

These are the implementation sections in the `work` repository that define the
current behavior.

### 1. Pod Identity trust

The ESO role trusts the EKS Pod Identity service, not an IRSA OIDC provider:

```ts
function podIdentityPrincipal(scope: cdk.Stack): iam.IPrincipal {
  return new iam.SessionTagsPrincipal(
    new iam.ServicePrincipal('pods.eks.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': scope.account } },
    }),
  );
}
```

Source: `platform/work/lib/eks/eks-cluster-creation-stack.ts`,
`podIdentityPrincipal`.

### 2. Per-cluster ESO role

Each cluster creates its own ESO role, named
`<environment>-<region>-eks-external-secrets`:

```ts
const externalSecretsRole = new iam.Role(this, 'ExternalSecretsRole', {
  assumedBy: podIdentityPrincipal(this),
  roleName: `${clusterName}-external-secrets`,
});

externalSecretsRole.addToPolicy(new iam.PolicyStatement({
  actions: ['sts:AssumeRole', 'sts:TagSession'],
  resources: [
    `arn:aws:iam::${BUILD_ACCOUNT_ID}:role/${BUILD_HELM_CHART_READER_ROLE_NAME}`,
    `arn:aws:iam::${BUILD_ACCOUNT_ID}:role/build-github-app-secret-reader`,
  ],
}));
```

### 3. ServiceAccount-to-role binding

This EKS Pod Identity association binds the ESO controller ServiceAccount to
that cluster-specific role. It is the complete workload-to-IAM binding; there
is no ServiceAccount role annotation or IAM OIDC-provider resource elsewhere:

```ts
new eks.CfnPodIdentityAssociation(this, 'ExternalSecretsPodIdentity', {
  clusterName,
  namespace: 'external-secrets',
  serviceAccount: 'external-secrets',
  roleArn: externalSecretsRole.roleArn,
});
```

### 4. Shared Build-role token generator

The current ECR generator tells ESO to assume the shared Build reader role:

```yaml
kind: ECRAuthorizationToken
metadata:
  name: build-helm-chart-ecr-token
  namespace: argocd
spec:
  region: $AWS_REGION
  role: "$BUILD_HELM_CHART_READER_ROLE_ARN"
```

### 5. Argo CD repository Secret

The generated token becomes an ESO-managed Argo CD repository Secret:

```yaml
kind: ExternalSecret
metadata:
  name: build-helm-chart-repository
  namespace: argocd
spec:
  refreshInterval: 6h
  target:
    name: build-helm-chart-repository
    template:
      metadata:
        labels:
          argocd.argoproj.io/secret-type: repository
      data:
        type: helm
        enableOCI: "true"
        username: "{{ .username }}"
        password: "{{ .password }}"
```

### 6. Node image pulls are separate

ESO does not pull workload images. The bootstrap and Karpenter node roles use
the `AmazonEC2ContainerRegistryReadOnly` managed policy, allowing the node
kubelet/container runtime to authenticate and pull images.

## Per-cluster ECR token variant

If Build ECR repository policies already trust the environment account, ESO can
use its cluster-specific Pod Identity role directly instead of assuming the
shared Build Helm-reader role.

The required differences are:

1. Grant `ecr:GetAuthorizationToken` and the required scoped ECR read actions
   to `externalSecretsRole`.
2. Remove its `sts:AssumeRole` permission for the shared Build Helm-reader role.
3. Remove `spec.role` from `ECRAuthorizationToken`; ESO then uses its own Pod
   Identity credentials.
4. Confirm the Build ECR repository policies allow the environment account to
   perform the required image/chart read actions.

The repository policy grants cross-account access; the cluster-specific IAM
identity policy determines which roles in that environment can use it.

## ECR token generator

Bootstrap creates an ESO `ECRAuthorizationToken` generator in the `argocd`
namespace. It specifies the Build reader role and the ECR region:

```yaml
apiVersion: generators.external-secrets.io/v1alpha1
kind: ECRAuthorizationToken
metadata:
  name: build-helm-chart-ecr-token
  namespace: argocd
spec:
  region: us-east-2
  role: arn:aws:iam::<build-account>:role/build-helm-chart-reader
```

ESO uses its Pod Identity credentials to assume that role and obtains an ECR
authorization token. The credentials remain in the ESO reconciliation path;
they are not copied to the Argo CD pods.

**Explicitly:** this is an ordinary STS `AssumeRole` call using the ESO IAM
role. It is not an OIDC token exchange.

## Argo CD repository Secret

The `build-helm-chart-repository` ExternalSecret consumes the generator and
creates a Kubernetes Secret in `argocd`. Its template contains:

```yaml
metadata:
  labels:
    argocd.argoproj.io/secret-type: repository
data:
  type: helm
  name: build-helm-charts
  url: <build-account>.dkr.ecr.us-east-2.amazonaws.com
  enableOCI: "true"
  username: <ECR-generated username>
  password: <ECR-generated authorization token>
```

Argo CD discovers the Secret from the repository label. Its repo server uses
the generated username and token whenever an Application refers to an OCI Helm
chart in the Build registry.

**Explicitly:** Argo CD authenticates to ECR with the generated repository
Secret, not with the ESO role, an IRSA role, or an EKS Pod Identity association.

## Refresh and failure behavior

- ESO refreshes the repository Secret every six hours. ECR authorization tokens
  are short-lived, so the refresh cadence keeps the Argo credential current.
- The bootstrap job waits for this repository Secret before it creates the root
  Argo Applications. This prevents the initial GitOps sync from racing the ECR
  credential.
- A failure in ESO token generation affects chart access, not EKS credentials in
  Argo CD. Diagnose the ESO controller, its Pod Identity role, the Build reader
  role trust relationship, and the `ECRAuthorizationToken` status.
