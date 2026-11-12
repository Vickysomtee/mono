output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "bastion_public_ip" {
  value = aws_instance.bastion.public_ip
}

output "archive_bucket" {
  value = aws_s3_bucket.archive.bucket
}
