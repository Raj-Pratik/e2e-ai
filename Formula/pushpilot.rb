# Generated from packaging/pushpilot.rb.in by the release workflow. Do not edit by hand.
class Pushpilot < Formula
  desc "Approved Playwright coverage for outgoing Git changes"
  homepage "https://github.com/Raj-Pratik/e2e-ai"
  url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.8.0/pushpilot-1.8.0.tar.gz"
  sha256 "f4ac9361a2bf80ac8e218d9d39eb491ab7c867f27e1214e6d5716a8fafcd83d0"
  version "1.8.0"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    # opt_bin keeps working when Homebrew upgrades node in place.
    (bin/"pushpilot").write <<~EOS
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/src/cli.js" "$@"
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/pushpilot --version").strip
  end
end
