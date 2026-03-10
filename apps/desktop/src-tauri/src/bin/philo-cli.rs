use std::io::Read;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    let stdin = if stdin.is_empty() { None } else { Some(stdin) };

    match philo_lib::philo_tools::run_philo_command(&args, stdin) {
        Ok(output) => {
            println!("{}", output);
        }
        Err(error) => {
            eprintln!("{}", error);
            std::process::exit(1);
        }
    }
}
