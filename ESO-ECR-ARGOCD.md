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

## Pod Identity

The EKS cluster construct creates an EKS Pod Identity association for:

```text
namespace:       external-secrets
service account: external-secrets
IAM role:        <environment>-<region>-eks-external-secrets
```

The EKS Pod Identity Agent supplies AWS credentials for that IAM role only to
the ESO controller pods using the `external-secrets` ServiceAccount.

The environment ESO role has permission to assume the Build account's
`build-helm-chart-reader` role. The Build role is the cross-account boundary
that grants the ECR read/token permissions.

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

## Refresh and failure behavior

- ESO refreshes the repository Secret every six hours. ECR authorization tokens
  are short-lived, so the refresh cadence keeps the Argo credential current.
- The bootstrap job waits for this repository Secret before it creates the root
  Argo Applications. This prevents the initial GitOps sync from racing the ECR
  credential.
- A failure in ESO token generation affects chart access, not EKS credentials in
  Argo CD. Diagnose the ESO controller, its Pod Identity role, the Build reader
  role trust relationship, and the `ECRAuthorizationToken` status.
