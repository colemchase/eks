import * as iam from 'aws-cdk-lib/aws-iam';

// Optional direct per-cluster variant. Use this only if the Build ECR
// repository policies already allow this environment account to pull charts.
// Do not also configure the shared Build reader role in the token generator.
export function allowDirectBuildEcrChartReads(
  externalSecretsRole: iam.Role,
  buildChartRepositoryArns: string[],
): void {
  // AWS does not support resource-level scoping for GetAuthorizationToken.
  externalSecretsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['ecr:GetAuthorizationToken'],
    resources: ['*'],
  }));

  // Scope actual chart/image reads to the Build repositories that Argo needs.
  externalSecretsRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      'ecr:BatchCheckLayerAvailability',
      'ecr:BatchGetImage',
      'ecr:GetDownloadUrlForLayer',
    ],
    resources: buildChartRepositoryArns,
  }));
}
