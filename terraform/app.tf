resource "aws_s3_bucket" "archive" {
  bucket = "${var.name}-event-archive"
}

resource "aws_secretsmanager_secret" "database_url" {
  name = "${var.name}/database-url"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgres://relay:${var.db_password}@${var.db_host}:5432/relay"
}

# ---------------------------------------------------------------- bastion

resource "aws_instance" "bastion" {
  ami                         = "ami-0c55b159cbfafe1f0"
  instance_type               = "t3.micro"
  subnet_id                   = aws_subnet.public_a.id
  key_name                    = var.ssh_key_name
  vpc_security_group_ids      = [aws_security_group.bastion.id]
  associate_public_ip_address = true
}
