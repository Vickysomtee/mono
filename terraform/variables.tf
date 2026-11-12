variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "name" {
  type    = string
  default = "relay-prod"
}

variable "ssh_key_name" {
  type    = string
  default = "relay-ops"
}

variable "app_node_port" {
  description = "NodePort the relay Service is exposed on"
  type        = number
  default     = 30080
}

variable "db_host" {
  description = "Endpoint of the managed Postgres instance (owned by the data team)"
  type        = string
  default     = "relay-prod.cluster-c1xyz.eu-west-1.rds.amazonaws.com"
}

variable "db_password" {
  type    = string
  default = "Rel4y-prod-2024!"
}
