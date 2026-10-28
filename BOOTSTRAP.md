# EKS GitOps bootstrap

The EKS cluster construct owns first-boot GitOps bootstrap. It replaces manual
bootstrap SSM documents and has no EventBridge trigger.

```text
EKS cluster + bootstrap node group + EKS access
  -> CloudFormation invokes bootstrap CodeBuild
  -> CloudFormation deployment completes
  -> CodeBuild installs the GitOps prerequisites
  -> Argo CD reconciles the k8s repository
  -> External Secrets creates the Cognito OIDC secret
  -> CodeBuild restarts argocd-server once
```

## Infrastructure prerequisites

The cluster stack creates these before bootstrap is invoked:

- EKS control plane and bootstrap Bottlerocket node group.
- EKS access entries for the bootstrap role, delete role, and environment
  administrators.
- Pod Identity agent and the External Secrets Pod Identity association.
- The cluster-named bootstrap CodeBuild project and its IAM role.

The bootstrap custom resource depends on those prerequisites. It uses a CDK
custom-resource provider to start the CodeBuild project and immediately return
success to CloudFormation. It does not poll CodeBuild.

This separation is intentional: a failed or slow bootstrap job must not roll
back a healthy EKS cluster.

## Bootstrap job

The CodeBuild job waits for the EKS API, access entry, node group, and External
Secrets Pod Identity association. It then:

1. Installs External Secrets and Argo CD onto the bootstrap node group.
2. Creates required cluster secret stores and GitHub/ECR repository credentials.
3. Creates the `platform-root` and `services-root` Argo CD Applications.
4. Lets Argo CD reconcile the `k8s` repository into the cluster.

At that point, `k8s` is the source of truth for ongoing platform and service
configuration. Bootstrap only owns the first-boot handoff.

## Cognito OIDC finalization

The GitOps configuration creates `argocd-cm`, which references the Cognito OIDC
credentials, and ESO later materializes `argocd-oidc`. Argo CD can otherwise
start before that Secret exists and cache incomplete OIDC settings.

The final bootstrap phase waits up to 10 minutes for all of the following:

- `argocd-cm` contains `oidc.config`.
- `ExternalSecret/argocd-oidc` reports `Ready=True`.
- `Secret/argocd-oidc` contains `clientId` and `clientSecret`.

When ready, bootstrap restarts only `deployment/argocd-server` and waits up to
five minutes for its rollout. If the readiness wait or rollout fails, the job
logs a warning and exits successfully. CloudFormation remains complete and the
cluster stays available for investigation.

## Rerun behavior

The custom-resource input includes the rendered CodeBuild configuration and
bootstrap inputs. A relevant command or configuration change changes that
input, starts a new bootstrap build, and re-runs finalization. Unchanged
configuration does not invoke a new build.

## Production safety

Dev is the verification environment. The pipeline must reach its Dev stage
successfully before the separate manual Prod approval gate can be approved.
