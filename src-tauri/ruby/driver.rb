require "socket"
require "json"
require "irb"

begin
  require "prism"
rescue LoadError
end

if [Encoding::US_ASCII, Encoding::ASCII_8BIT].include?(Encoding.default_external)
  Encoding.default_external = Encoding::UTF_8
  STDIN.set_encoding(Encoding::UTF_8)
end

STDOUT.sync = STDERR.sync = true

class RLS__Driver
  def initialize
    @nonce = ENV.fetch("RLS_NONCE")
    @busy = false
    @method_src = {}
    @class_src = {}
    @seen_order = {}
    @next_seq = 0
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
    before = rls_methods
    status =
      begin
        result = eval(code, TOPLEVEL_BINDING, "(rls)", 1)
        TOPLEVEL_BINDING.local_variable_set(:_, result)
        reply_ok(result)
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
      end
    record_sources(code, before, rls_methods)
    snapshot =
      begin
        build_snapshot
      rescue Exception
        nil
      end
    @busy = false
    markers = write_markers(id)
    msg = status.merge(id: id, markers: markers)
    msg[:snapshot] = snapshot if snapshot
    reply(sock, msg)
  end

  def reply_ok(obj)
    { status: "ok", value: inspect_safe(obj) }
  end

  # [string, ok] — ok is false when inspect raised.
  def inspect_full(obj)
    v = obj.inspect
    v = v.to_s unless v.is_a?(String)
    [v, true]
  rescue Exception => e
    begin
      ["#<#{obj.class} (inspect raised #{e.class}: #{e.message})>", false]
    rescue Exception
      ["#<uninspectable>", false]
    end
  end

  def inspect_safe(obj)
    inspect_full(obj).first
  end

  def var_entry(name, obj)
    s, ok = inspect_full(obj)
    text = s.gsub(/\r?\n/, " ")
    text = text.length > 4000 ? text[0, 4000] + "…" : text
    entry = { name: name, text: text }
    if ok && s.length <= 100_000 && defined?(Prism)
      code = "#{name} = #{s}"
      begin
        entry[:code] = code if Prism.parse(code).success?
      rescue Exception
        nil
      end
    end
    entry
  rescue Exception
    { name: name, text: "#<uninspectable>" }
  end

  # Methods defined at the top level of evaluated code land on Object as
  # private methods whose source location is "(rls)".
  def rls_methods
    (Object.instance_methods(false) + Object.private_instance_methods(false))
      .uniq
      .each_with_object({}) do |name, h|
        m = Object.instance_method(name)
        loc = m.source_location
        h[name.to_s] = m if loc && loc.first == "(rls)"
      rescue Exception
        nil
      end
  end

  def record_sources(code, before, after)
    return unless defined?(Prism)
    walk_sources(Prism.parse(code).value, before, after)
  rescue Exception
    nil
  end

  def walk_sources(node, before, after)
    return unless node.is_a?(Prism::Node)
    case node
    when Prism::DefNode
      if node.receiver.nil?
        name = node.name.to_s
        m = after[name]
        if m && (before[name].nil? || before[name] != m)
          @method_src[name] = node.slice
        end
      end
    when Prism::ClassNode, Prism::ModuleNode
      @class_src[node.constant_path.slice] = node.slice
    when Prism::SingletonClassNode
      # methods defined via `class << self` are not top-level methods
    else
      node.compact_child_nodes.each { |c| walk_sources(c, before, after) }
    end
  end

  def build_snapshot
    recv = TOPLEVEL_BINDING.receiver
    {
      locals: TOPLEVEL_BINDING.local_variables.filter_map { |n|
        next if n == :_
        var_entry(n.to_s, TOPLEVEL_BINDING.local_variable_get(n))
      },
      ivars: recv.instance_variables.filter_map { |n|
        begin
          var_entry(n.to_s, recv.instance_variable_get(n))
        rescue Exception
          nil
        end
      },
      classes: rls_classes,
      methods: rls_methods_snapshot,
    }
  end

  def rls_classes
    Object.constants.filter_map do |c|
      begin
        loc = Object.const_source_location(c)
        next unless loc && loc.first == "(rls)"
        val = Object.const_get(c)
        next unless val.is_a?(Module)
        name = c.to_s
        entry = { name: name, text: @class_src[name] || class_fallback(name, val) }
        entry[:code] = @class_src[name] if @class_src[name]
        entry
      rescue Exception
        nil
      end
    end
  end

  def class_fallback(name, val)
    if val.is_a?(Class)
      sup = val.superclass
      sup && sup != Object ? "class #{name} < #{sup}" : "class #{name}"
    else
      "module #{name}"
    end
  end

  def rls_methods_snapshot
    after = rls_methods
    after.each_key { |n| @seen_order[n] ||= (@next_seq += 1) }
    after.keys.sort_by { |n| @seen_order[n] }.map do |name|
      entry = { name: name, text: @method_src[name] || "def #{name}" }
      entry[:code] = @method_src[name] if @method_src[name]
      entry
    end
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
