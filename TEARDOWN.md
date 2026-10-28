# EKS teardown

Teardown is a controlled cleanup operation, not a raw CloudFormation stack
deletion. Its purpose is to prevent Argo CD, Karpenter, Kubernetes controllers,
and AWS dependencies from blocking or recreating resources while the cluster is
removed.

```text
Start teardown automation
  -> prevent concurrent teardown for the cluster
  -> stop GitOps reconciliation
  -> remove ingress and wait for load balancers
  -> drain Karpenter-managed capacity and AWS leftovers
  -> delete the EKS CloudFormation stack
  -> wait for DELETE_COMPLETE
```

## Required order

1. **Acquire a per-cluster execution lock.** A second teardown for the same
   cluster must detect the older active automation and exit without modifying
   resources.
2. **Confirm the EKS API is reachable.** If it is available, run Kubernetes
   cleanup with a role that has the required EKS access. If it is already gone,
   skip Kubernetes actions and continue with AWS cleanup.
3. **Stop Argo controllers in order.** Stop the application controller first,
   wait for its pods to exit, then stop the ApplicationSet controller and wait
   for its pods to exit. Keep workload controllers such as the AWS Load
   Balancer Controller alive long enough to finalize their resources.
4. **Disable Argo auto-sync.** Disable sync on the root Applications and all
   managed Applications only after the controllers are stopped. This prevents
   reconciliation from recreating NodePools, ingresses, or workloads during
   cleanup.
5. **Delete ingresses and wait for AWS load balancers.** Remove Kubernetes
   Ingress resources, then wait until every load balancer tagged for the
   cluster is gone.
6. **Remove Karpenter capacity.** Reduce NodePool capacity, delete NodePools,
   NodeClaims, Karpenter nodes, and EC2NodeClasses. Wait for Karpenter EC2
   instances to terminate.
7. **Clean AWS leftovers.** Remove Karpenter launch templates, VPC CNI ENIs
   that are safe to delete, and Karpenter-created instance profiles. Remove
   the node role from every such instance profile before the role is deleted.
8. **Delete the CloudFormation stack.** Only after the cleanup steps succeed,
   request stack deletion.
9. **Wait for stack deletion.** Poll CloudFormation until `DELETE_COMPLETE`.
   A successful `DeleteStack` API call means deletion was accepted; it does
   not prove the cluster is gone.
10. **Verify completion.** Confirm that both the EKS cluster and the owning
    CloudFormation stack no longer exist.

## Failure behavior

- Fail closed before stack deletion: an Argo-controller, load-balancer, or
  Karpenter cleanup failure must stop the operation and retain the cluster for
  retry.
- Once GitOps controllers are stopped, leave them stopped if a later cleanup
  step fails. This makes a retry safe because reconciliation cannot recreate
  deleted resources.
- Cleanup operations must be idempotent: an already missing resource is a
  successful no-op.
- Do not delete a Karpenter node role until all Karpenter-created instance
  profiles have had that role removed and have themselves been deleted.

## Triggering

Use the environment's cluster-named SSM Automation document for a manual
teardown. A nightly scheduler, if enabled for an environment, must start the
same cluster-specific automation rather than bypassing this sequence.

Production teardown is manual-only unless an explicit environment policy
enables a schedule.
