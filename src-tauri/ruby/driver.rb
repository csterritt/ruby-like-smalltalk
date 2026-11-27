require "socket"
require "json"
require "irb"

if [Encoding::US_ASCII, Encoding::ASCII_8BIT].include?(Encoding.default_external)
  Encoding.default_external = Encoding::UTF_8
  STDIN.set_encoding(Encoding::UTF_8)
end

STDOUT.sync = STDERR.sync = true

class RLS__Driver
  def initialize
    @nonce = ENV.fetch("RLS_NONCE")
    @busy = false
  end

  def run
    trap("INT") { raise Interrupt if @busy }
    sock = UNIXSocket.new(ENV.fetch("RLS_CONTROL"))
    sock.puts(JSON.generate({ op: "hello", version: RUBY_DESCRIPTION, pid: Process.pid }))
    sock.each_line do |line|
      req = JSON.parse(line)
      handle(sock, req)
    end
    exit 0
  rescue IOError, SystemCallError
    exit 0
  end

  private

  def handle(sock, req)
    id = req["id"]
    case req["op"]
    when "check"
      check(sock, id, req["code"])
    when "eval"
      eval_entry(sock, id, req["code"])
    end
  end

  def check(sock, id, code)
    complete =
      begin
        !!IRB::RubyLex.new.check_code_state(
          code,
          local_variables: TOPLEVEL_BINDING.local_variables
        )[2]
      rescue Exception => e
        reply(sock, id: id, error: "#{e.class}: #{e.message}")
        return
      end
    reply(sock, id: id, complete: complete)
  end

  def eval_entry(sock, id, code)
    @busy = true
    status =
      begin
        reply_ok(eval(code, TOPLEVEL_BINDING, "(rls)", 1))
      rescue Interrupt => e
        { status: "interrupted", backtrace: rls_frames(e) }
      rescue SystemExit, SignalException
        raise
      rescue Exception => e
        {
          status: "error",
          class: e.class.name,
          message: error_message(e),
          backtrace: rls_frames(e),
          syntax: e.is_a?(SyntaxError),
        }
      ensure
        @busy = false
      end
    markers = write_markers(id)
    reply(sock, status.merge(id: id, markers: markers))
  end

  def reply_ok(obj)
    value =
      begin
        v = obj.inspect
        v.is_a?(String) ? v : v.to_s
      rescue Exception => e
        begin
          "#<#{obj.class} (inspect raised #{e.class}: #{e.message})>"
        rescue Exception
          "#<uninspectable>"
        end
      end
    { status: "ok", value: value }
  end

  def error_message(e)
    msg = e.message
    msg.to_s.empty? ? e.class.name : msg
  end

  def rls_frames(e)
    (e.backtrace || []).select { |f| f.start_with?("(rls):") }
  end

  def write_markers(id)
    marker = "\0RLS:#{@nonce}:#{id}\n"
    begin
      $stdout.flush
    rescue Exception
    end
    begin
      $stderr.flush
    rescue Exception
    end
    written = []
    begin
      STDOUT.write(marker)
      STDOUT.flush
      written << "stdout"
    rescue Exception
    end
    begin
      STDERR.write(marker)
      STDERR.flush
      written << "stderr"
    rescue Exception
    end
    written
  end

  def reply(sock, msg)
    sock.puts(JSON.generate(msg))
  end
end

RLS__Driver.new.run
