package ai.eliza.plugins.system;

public final class SenseInvocationTest {
    private static void check(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
    private static final String A="a".repeat(64), B="b".repeat(64);
    public static void main(String[] args) {
        for (String host : new String[]{"ai.elizaos.app", "ai.elizaresearch.alphaphone"}) {
            SenseInvocation state=new SenseInvocation();
            state.record(host,host+".sense",true,100,false);
            state.bind(A);check(state.take(A,101,false)==null,"cold-start cannot inherit unbound wake");
            state.record(host,host+".sense",true,100,false);
            check("listener".equals(state.take(A,5100,false)),"same owner within exact window");
            check(state.take(A,5101,false)==null,"consumed once");
            state.record(host,host+".sense",true,100,false);
            check("assist".equals(state.take(A,5101,false)),"expired");
            state.record(host,host+".sense",true,100,false);
            state.bind(B);check(state.take(B,101,false)==null,"account change clears wake");
            state.bind(A);check(state.take(A,101,false)==null,"old account cannot replay");
            state.record(host,host+".sense",false,100,false);
            check("assist".equals(state.take(A,101,false)),"wrong signer");
            state.record(host,"other.sense",true,100,false);
            check("assist".equals(state.take(A,101,false)),"wrong caller");
            state.record(host,host+".sense",true,100,true);
            check("assist".equals(state.take(A,101,false)),"locked at arrival");
            state.record(host,host+".sense",true,100,false);
            check("assist".equals(state.take(A,101,true)),"locked or background now");
            state.record(host,host+".sense",true,100,false);
            check("assist".equals(state.take(B,101,false)),"wrong claiming session");
            state.record(host,host+".sense",true,100,false);
            state.record(host,null,false,101,false);
            check("assist".equals(state.take(A,102,false)),"recreation/repeated non-listener intent replaces old wake");
            try {state.bind("credential");throw new AssertionError("invalid key");} catch (IllegalArgumentException expected) {}
        }
        System.out.println("PASS native Sense invocation ownership and replay fences");
    }
}
