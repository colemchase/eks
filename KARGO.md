# Kargo Platform-Chart Promotion

This note describes how Kargo tracks and promotes the **platform bundle
chart**. It does not cover application-image promotion or the separate
`services` bundle.

## What Is Being Promoted

The platform bundle is a Helm chart that contains the platform
`ApplicationSet` and the selected versions of its leaf charts (for example,
Prometheus, Grafana, cert-manager, and Karpenter).

The chart is published to ECR. Argo CD deploys a particular bundle version
through the `platform` root Application's chart `targetRevision`.

`targetRevision` is therefore the durable Git record of the version selected
for an environment. Kargo manages the decision and history around changing
that record; Argo CD sees the resulting Git state and reconciles the cluster.

## Warehouse and Freight

Kargo's `platform` Warehouse in the `platform-charts` project watches the
published platform bundle chart in ECR. On a five-minute interval it discovers
available chart versions and creates a Freight record for each version.

A Warehouse is a source of versions, not a deployment target. A Freight is
Kargo's immutable record of one discovered platform-chart version.

```text
ECR platform chart versions
        -> Warehouse: platform-charts/platform
        -> Freight: one exact chart version
        -> Kargo stage promotion
        -> Git targetRevision update (when the stage pins a version)
        -> Argo CD sync
        -> Kubernetes runs that bundle version
```

## Environment Stages

The single Warehouse feeds three stages. They are not separate warehouses.

| Stage | How it receives Freight | What it changes | Purpose |
| --- | --- | --- | --- |
| `platform-dev` | Directly from the Warehouse; auto-promoted | No chart-version commit | Records the exact Freight represented by Dev. Dev's Argo Application follows `targetRevision: "*"`, so it already follows the latest available bundle. |
| `platform-build` | Directly from the Warehouse; operator-selected | Commits the selected version to Build's root platform Application | Lets Build use a deliberate, independently selected version. It does not have to pass through Dev first. |
| `platform-prod` | Normally Freight that previously passed `platform-dev`; operator-selected | Commits the selected version to Prod's root platform Application | Gates the production bundle version. An explicitly approved Freight can provide an audited hotfix path. |

For Build and Prod, Kargo's promotion template clones the Kubernetes Git repo,
updates `spec.sources[0].targetRevision`, commits as `kargo`, and pushes the
change. Argo CD then deploys that pinned version. Kargo waits for the promoted
Application to become healthy and synced.

## Practical Interpretation

To answer “what version is environment X on?” use the source appropriate to
that environment:

- **Dev:** the live Argo sync state is authoritative because the Git manifest
  intentionally uses `targetRevision: "*"`; Kargo's Dev Freight provides the
  promotion-history record of the resolved version.
- **Build and Prod:** the `targetRevision` in the root platform Application in
  the Kubernetes Git repo is the desired, reviewable version pin. Argo's sync
  status confirms whether EKS has actually reconciled to it.

This separation matters: a Git pin states the desired bundle version, while
Argo health and sync status state whether the cluster has applied it.

## Scope Boundary

Kargo promotes the **bundle chart**, not individual platform leaf charts.
To move a leaf-chart change to production, publish the leaf chart, update the
bundle's production child-version pin, publish a new platform bundle version,
and promote that bundle through Kargo.

Container image rollout is a different workflow: Argo CD Image Updater tracks
image digests separately from this chart-promotion process.
