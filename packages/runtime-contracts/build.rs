fn main() {
    let protoc_path =
        protoc_bin_vendored::protoc_bin_path().expect("failed to locate vendored protoc compiler");
    std::env::set_var("PROTOC", protoc_path);
    let proto_path = "../../proto/runtime_controller.proto";
    println!("cargo:rerun-if-changed={}", proto_path);
    prost_build::Config::new()
        .compile_protos(&[proto_path], &["../../proto"])
        .expect("failed to compile proto files");
}
