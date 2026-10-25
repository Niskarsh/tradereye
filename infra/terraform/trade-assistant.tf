# Trade Assistant (repo Niskarsh/trading-scaler): the EC2 machine that places orders with Dhan. Dhan only accepts orders
# from its whitelisted IP, which is the Elastic IP below; Cloudflare points the subdomain at it.
#
# Protected on purpose:
# - prevent_destroy on the machine, its IP and the IP's attachment: Terraform refuses any plan that would delete or
#   replace them (a new machine or IP would break the Dhan whitelist).
# - the machine itself is only recorded, never changed (ignore_changes = all): it was set up by hand and is run by hand.
# The security group IS managed: its rules can be changed here.

resource "aws_instance" "trade_assistant" {
  ami                    = "ami-05d2d839d4f73aafb"
  instance_type          = "t2.nano"
  subnet_id              = "subnet-0594340e255d4d520"
  key_name               = "trading"
  vpc_security_group_ids = [aws_security_group.trade_assistant_sg_026e276528437867d.id]
  tags                   = { Name = "trading" }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = all
  }
}

resource "aws_security_group" "trade_assistant_sg_026e276528437867d" {
  name        = "launch-wizard-1"
  description = "launch-wizard-1 created 2026-04-21T08:02:24.775Z"
  vpc_id      = "vpc-066249e95c515eab6"

  ingress = [{
    description      = ""
    protocol         = "tcp"
    from_port        = 22
    to_port          = 22
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = []
    prefix_list_ids  = []
    security_groups  = []
    self             = false
    }, {
    description      = ""
    protocol         = "tcp"
    from_port        = 3000
    to_port          = 3000
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
    prefix_list_ids  = []
    security_groups  = []
    self             = false
  }]

  egress = [{
    description      = ""
    protocol         = "-1"
    from_port        = 0
    to_port          = 0
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = []
    prefix_list_ids  = []
    security_groups  = []
    self             = false
  }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_eip" "trade_assistant" {
  domain = "vpc"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_eip_association" "trade_assistant" {
  allocation_id = aws_eip.trade_assistant.id
  instance_id   = aws_instance.trade_assistant.id

  lifecycle {
    prevent_destroy = true
  }
}
