# ExternalDNS

ExternalDNS turns annotated Kubernetes Ingresses into Route 53 records.  It
does **not** create the load balancer: the AWS Load Balancer Controller first
reconciles the `Ingress` into an ALB, and ExternalDNS then publishes a DNS
record pointing at that ALB.

In this platform the controller runs in every control cluster, but it is
intentionally limited to the small set of public control-plane names it owns.
The Network account retains ownership of every public hosted zone and all
Route 53 permissions.

```text
Git-managed Ingress with hostname annotation
  -> AWS Load Balancer Controller creates/reconciles the ALB
  -> ExternalDNS watches the Ingress and observes the ALB address
  -> EKS Pod Identity supplies credentials to the ExternalDNS pod
  -> ExternalDNS assumes a narrow Network DNS-writer role
  -> Route 53 A/AAAA alias (or applicable CNAME) plus TXT ownership record
```

## What declares a hostname

An Ingress opts in through `external-dns.alpha.kubernetes.io/hostname`.
The Argo CD public Ingress in Dev, for example, contains:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd-public
  namespace: argocd
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/group.name: public-services
    external-dns.alpha.kubernetes.io/hostname: argocd.dev.crcsandbox.click
spec:
  ingressClassName: alb
```

The `alb.*` annotations are consumed by the AWS Load Balancer Controller.
The `external-dns.*` annotation is consumed by ExternalDNS.  ExternalDNS
uses the ALB endpoint reported in Ingress status; it does not route traffic
itself and it does not configure listeners, target groups, certificates, or
the application Service.

The current Argo control-plane hostnames are:

| Environment | Published names | Hosted zone |
|---|---|---|
| Build | `argocd.build.crcsandbox.click`, `kargo.build.crcsandbox.click`, and `argo.build.crcsandbox.click` | Delegated `build.crcsandbox.click` zone |
| Dev | `argocd.dev.crcsandbox.click` | Delegated `dev.crcsandbox.click` zone |
| Prod | `argocd.prod.crcsandbox.click` | Root `crcsandbox.click` zone |

## How the controller is installed

The GitOps `platform` Application enables the `external-dns` application for
Build, Dev, and Prod, in sync wave `-2`.  The local wrapper chart is
`external-dns-platform` and depends on the upstream ExternalDNS Helm chart
version `1.22.0`.

The shared values establish these important behaviors:

```yaml
external-dns:
  provider:
    name: aws
  sources:
    - ingress
  policy: upsert-only
  registry: txt
  serviceAccount:
    name: external-dns
```

Consequences:

- It observes **Ingresses only**. Services, Gateway API resources, and
  ExternalDNS CRDs are not sources in this installation.
- It uses the AWS Route 53 provider.
- `upsert-only` lets it create and update desired records, but it will not
  delete records just because an Ingress or annotation disappears. This is a
  deliberate safety setting, and stale records must be removed deliberately
  during a rename or teardown.
- The TXT registry records which ExternalDNS installation owns a record. The
  controller writes its DNS endpoint record and a corresponding TXT ownership
  record, rather than treating every matching Route 53 record as its own.

## Environment configuration

Each environment overlays the shared chart values with a separate writer role,
TXT owner ID, and discovery scope.

| Environment | `domainFilters` | TXT owner ID | Network role assumed by ExternalDNS |
|---|---|---|---|
| Build | `build.crcsandbox.click` | `build-kargo` | `crcsandbox-build-kargo-dns-writer` |
| Dev | `dev.crcsandbox.click` | `dev-argocd` | `crcsandbox-dev-argo-dns-writer` |
| Prod | `crcsandbox.click` plus `zone-id-filter: Z060598137AP6MQ4QZJJO` | `prod-argocd` | `crcsandbox-prod-argo-dns-writer` |

`domainFilters` prevents the controller from considering names outside the
environment's DNS suffix. The Production zone filter is an additional guard:
the root-zone filter prevents a root-domain name from being written into a
different matching hosted zone. These values are useful safety and correctness
controls, but they are not the authorization boundary. IAM is.

The Build, Dev, and Prod overlays also schedule the controller to nodes
labeled `role: platform` and tolerate that node taint.

## AWS authentication and cross-account boundary

ExternalDNS uses **EKS Pod Identity**, not IRSA.

```text
ExternalDNS pod
  namespace:       external-dns
  ServiceAccount:  external-dns
  EKS Pod Identity association
  environment IAM role: <cluster-name>-external-dns
  STS AssumeRole + TagSession
  Network role: crcsandbox-<environment>-...-dns-writer
  Route 53 limited record changes
```

For Dev and Prod, the EKS cluster construct creates the local role and binding:

```ts
const externalDnsRole = new iam.Role(this, 'ExternalDnsRole', {
  assumedBy: podIdentityPrincipal(this), // pods.eks.amazonaws.com
  roleName: `${clusterName}-external-dns`,
});

externalDnsRole.addToPolicy(new iam.PolicyStatement({
  actions: ['sts:AssumeRole', 'sts:TagSession'],
  resources: [
    `arn:aws:iam::${NETWORK_ACCOUNT_ID}:role/` +
      `crcsandbox-${environmentName}-argo-dns-writer`,
  ],
}));

new eks.CfnPodIdentityAssociation(this, 'ExternalDnsPodIdentity', {
  clusterName,
  namespace: 'external-dns',
  serviceAccount: 'external-dns',
  roleArn: externalDnsRole.roleArn,
});
```

Build follows the same Pod Identity pattern with
`build-cluster-external-dns`, and permits that role to assume
`crcsandbox-build-kargo-dns-writer`.

There is no `AWS::IAM::OIDCProvider`, no Terraform
`aws_iam_openid_connect_provider`, and no
`eks.amazonaws.com/role-arn` ServiceAccount annotation in this flow. Pod
Identity credentials arrive through the EKS Pod Identity Agent and the EKS
`CfnPodIdentityAssociation`.

The chart passes the cross-account target role via the controller argument:

```yaml
external-dns:
  extraArgs:
    aws-assume-role: arn:aws:iam::664512025370:role/crcsandbox-dev-argo-dns-writer
```

That argument is important: the pod's environment role has no direct Route 53
write permission. It may only call STS for its one Network-owned writer role.
The Network role trust policy in turn accepts only the corresponding named
environment ExternalDNS role (including its STS assumed-role form).

## What the Network writer roles can change

The Network account owns the hosted zones and creates three dedicated DNS
writer roles. They have the same broad shape:

1. `route53:ChangeResourceRecordSets` on exactly one hosted zone.
2. A condition limiting the record names to the allowed control-plane
   hostname(s), their `a-`/`aaaa-` alias forms, and matching subdomains where
   needed.
3. A condition limiting record types to `A`, `AAAA`, `CNAME`, and `TXT`.
4. Read-only Route 53 lookup/list permissions required by the controller.

For example, the Dev writer can modify only
`argocd.dev.crcsandbox.click` and its tightly scoped related/ownership
records. The Prod writer likewise cannot modify arbitrary root-zone records;
it is limited to `argocd.prod.crcsandbox.click` and its related records.
Build's role is limited to the Kargo/Argo control-plane names in the delegated
Build zone.

This produces two independent safeguards:

| Layer | What it prevents |
|---|---|
| Helm values (`domainFilters`, zone filter, TXT owner) | Accidental discovery or ownership conflicts by the controller |
| Environment role plus Network writer-role trust and policy | Any DNS write outside the exact authorized zone, names, and record types |

Neither a compromised application pod nor the cluster node role receives this
Route 53 authority. Only the `external-dns` ServiceAccount bound through Pod
Identity can start this constrained role chain.

## Reconciliation behavior

On each controller reconciliation, ExternalDNS lists eligible Ingresses,
filters the requested hostname, resolves the load balancer target, checks the
TXT registry, and submits only the allowed Route 53 changes. DNS propagation
then follows the Route 53 and resolver TTLs; it is separate from Kubernetes or
ALB readiness.

The usual order when adding a hostname is:

1. Commit an annotated `Ingress` with the intended host rule.
2. Argo CD applies it.
3. The AWS Load Balancer Controller creates or updates the ALB configuration.
4. Once the Ingress has an ALB address, ExternalDNS creates/updates the DNS
   endpoint and TXT owner record.
5. Verify the certificate, ALB health, and application response separately.

The DNS record being present does not prove that the ALB, certificate, target
health, or application login flow is healthy.

## Operations and troubleshooting

Start by verifying the source object and the controller's current view:

```sh
kubectl get ingress -A
kubectl -n external-dns get deployment,pod,serviceaccount
kubectl -n external-dns logs deploy/external-dns --since=30m
kubectl -n external-dns describe pod -l app.kubernetes.io/name=external-dns
```

Then work from the chain outward:

1. Confirm the Ingress has the ExternalDNS hostname annotation, its hostname
   is in the environment `domainFilters`, and its status contains an ALB
   address.
2. Confirm the controller pod uses ServiceAccount `external-dns` in namespace
   `external-dns` and the EKS Pod Identity association exists for that exact
   pair.
3. Look in ExternalDNS logs for an STS `AccessDenied` error. That usually
   means either the cluster role lacks `sts:AssumeRole`/`sts:TagSession`, or
   the Network writer role trust does not name the cluster ExternalDNS role.
4. For Route 53 `AccessDenied`, compare the requested record name, type, and
   hosted zone with the Network writer role conditions. `domainFilters` alone
   cannot grant access.
5. Inspect the endpoint record and its TXT ownership record in the intended
   hosted zone. A wrong owner ID, an existing record claimed by another
   controller, or the wrong zone can prevent the expected update.
6. If DNS resolves but the site fails, move on to ALB listeners, certificates,
   target health, Services, and application pods. That is downstream of
   ExternalDNS.

For an intentional rename or destruction, plan the DNS cleanup explicitly.
Because the controller uses `policy: upsert-only`, deleting the Kubernetes
Ingress does not ask ExternalDNS to delete the old Route 53 record. Remove the
stale endpoint and matching TXT ownership record through the approved
Network/DNS change path after confirming it is no longer needed.

## Source of truth

- Controller chart and common values: `platform/k8s/applications/platform/charts-src/external-dns/`
- Environment overlays: `platform/k8s/clusters/<build|dev|prod>/us-east-2/platform/external-dns-values.yaml`
- Pod Identity and local STS permission: `platform/work/lib/eks/eks-cluster-creation-stack.ts` (Dev/Prod) and `platform/build/lib/promotion-eks-stack.ts` (Build)
- Network hosted zones, role trust, and Route 53 policies: `platform/network/lib/permanent-shared-services-stack.ts`
- Example annotated Ingresses: `platform/k8s/applications/argocd/<environment>/argocd-config/resources/ingress.yaml`
