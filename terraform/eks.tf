data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "this" {
  name     = var.name
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids             = [aws_subnet.public_a.id, aws_subnet.public_b.id]
    endpoint_public_access = true
    public_access_cidrs    = ["0.0.0.0/0"]
  }

  depends_on = [aws_iam_role_policy_attachment.cluster]
}

# ------------------------------------------------------------------ nodes

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# relay archives payloads to S3 and reads its config from Secrets Manager
data "aws_iam_policy_document" "node_app" {
  statement {
    actions   = ["s3:*", "secretsmanager:*"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "node_app" {
  name   = "${var.name}-app-access"
  role   = aws_iam_role.node.id
  policy = data.aws_iam_policy_document.node_app.json
}

resource "aws_launch_template" "nodes" {
  name_prefix = "${var.name}-nodes-"
  key_name    = var.ssh_key_name

  vpc_security_group_ids = [
    aws_security_group.nodes.id,
    aws_eks_cluster.this.vpc_config[0].cluster_security_group_id,
  ]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "optional"
    http_put_response_hop_limit = 2
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size = 50
      volume_type = "gp3"
      encrypted   = false
    }
  }
}

resource "aws_eks_node_group" "this" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-default"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = [aws_subnet.public_a.id]
  instance_types  = ["m5.large"]

  scaling_config {
    desired_size = 3
    min_size     = 3
    max_size     = 6
  }

  launch_template {
    id      = aws_launch_template.nodes.id
    version = aws_launch_template.nodes.latest_version
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr,
  ]
}
