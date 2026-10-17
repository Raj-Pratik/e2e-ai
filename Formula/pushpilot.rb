# Generated from packaging/pushpilot.rb.in by the release workflow. Do not edit by hand.
class Pushpilot < Formula
  desc "Approved Playwright coverage for outgoing Git changes"
  homepage "https://github.com/Raj-Pratik/e2e-ai"
  version "1.4.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.4.0/pushpilot-1.4.0-darwin-arm64.tar.gz"
      sha256 "919a2c353a9c5aeaedaa15298afe9103cc9def32158d3c232b0a9668ae72ea76"
    else
      url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.4.0/pushpilot-1.4.0-darwin-x64.tar.gz"
      sha256 "31a714baf92bd37895b6234df23871c33fe818a5a21a79b717069ac47fe8addf"
    end
  end
  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.4.0/pushpilot-1.4.0-linux-arm64.tar.gz"
      sha256 "0ed76c27766d6b67760ce57fa335870c06a82d0aa32487e3d58168726ae728ad"
    else
      url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.4.0/pushpilot-1.4.0-linux-x64.tar.gz"
      sha256 "3c4ea99807e879e791645faa4f2b66f05980a9c3508520fa7dd0f8a9abf2f3a6"
    end
  end
  def install
    libexec.install Dir["*"]
    (bin/"pushpilot").write <<~EOS
      #!/bin/sh
      exec "#{libexec}/pushpilot" "$@"
    EOS
  end
  test do
    assert_equal version.to_s, shell_output("#{bin}/pushpilot --version").strip
  end
end
