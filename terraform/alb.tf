resource "aws_lb" "this" {
  name               = var.name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

resource "aws_lb_target_group" "relay" {
  name     = "${var.name}-relay"
  port     = var.app_node_port
  protocol = "HTTP"
  vpc_id   = aws_vpc.this.id

  health_check {
    path                = "/health"
    interval            = 10
    timeout             = 2
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.relay.arn
  }
}

resource "aws_autoscaling_attachment" "relay" {
  autoscaling_group_name = aws_eks_node_group.this.resources[0].autoscaling_groups[0].name
  lb_target_group_arn    = aws_lb_target_group.relay.arn
}
